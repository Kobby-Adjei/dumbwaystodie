const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const {
  MediaRegistry,
  mimeTypeFor,
  supportedExtensions,
} = require("../out/media/MediaRegistry.js");

/**
 * Media registry (spec §9, §10, §85, §0M).
 *
 * The registry decides which bytes are allowed to leave the machine, so these
 * check the refusals as carefully as the successes.
 */

let sandbox;
let mediaDir;
let registry;

const shot = (name) => path.join(sandbox, name);

test.before(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dumbways-media-")));
  mediaDir = path.join(sandbox, ".coach", "media");

  await fs.writeFile(shot("screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await fs.writeFile(shot("copy-of-screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await fs.writeFile(shot("notes.md"), "# notes\n");
  await fs.writeFile(shot("program.exe"), Buffer.from([0x4d, 0x5a]));
  await fs.writeFile(shot("no-extension"), "plain");

  registry = new MediaRegistry({ mediaDir, maxBytes: 1024 });
});

test.after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * What is allowed in
 * ------------------------------------------------------------------ */

test("maps supported extensions to MIME types (spec §10)", () => {
  assert.equal(mimeTypeFor("a/b/shot.png"), "image/png");
  assert.equal(mimeTypeFor("SHOT.PNG"), "image/png");
  assert.equal(mimeTypeFor("doc.pdf"), "application/pdf");
  assert.equal(mimeTypeFor("data.csv"), "text/csv");
  assert.equal(mimeTypeFor("binary.exe"), undefined);
  assert.equal(mimeTypeFor("no-extension"), undefined);
  assert.ok(supportedExtensions().includes(".png"));
});

test("registers a file, hashes it, and copies it into .coach/media", async () => {
  const ref = await registry.register(shot("screenshot.png"), "screenshot");

  assert.match(ref.id, /^media_[0-9a-f]{12}$/);
  assert.equal(ref.filename, "screenshot.png");
  assert.equal(ref.mimeType, "image/png");
  assert.equal(ref.size, 7);
  assert.equal(ref.source, "screenshot");

  // The hash is of the real bytes, not of the name or the path.
  const expected = createHash("sha256")
    .update(await fs.readFile(shot("screenshot.png")))
    .digest("hex");
  assert.equal(ref.sha256, expected);

  // The copy exists, and the original is untouched.
  const stored = await fs.readFile(ref.localMediaPath);
  assert.deepEqual([...stored], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.ok(ref.localMediaPath.startsWith(mediaDir), "media must live under .coach/media");

  const mode = (await fs.stat(ref.localMediaPath)).mode & 0o777;
  assert.equal(mode, 0o600, "attachments are user data, not world-readable");
});

test("identical bytes reuse one object (spec §85)", async () => {
  const first = await registry.register(shot("screenshot.png"), "screenshot");
  const second = await registry.register(shot("copy-of-screenshot.png"), "filesystem");

  assert.equal(second.id, first.id, "the same bytes must not be stored twice");
  assert.equal(second.localMediaPath, first.localMediaPath);

  const files = await fs.readdir(mediaDir);
  const pngs = files.filter((name) => name.endsWith(".png"));
  assert.equal(pngs.length, 1, `expected one stored png, found ${pngs.join(", ")}`);
});

test("an unsupported type is refused, with the supported list in the message", async () => {
  await assert.rejects(registry.register(shot("program.exe"), "filesystem"), (error) => {
    assert.equal(error.code, "UNSUPPORTED");
    assert.match(error.message, /\.png/);
    return true;
  });

  await assert.rejects(registry.register(shot("no-extension"), "filesystem"), (error) => {
    assert.equal(error.code, "UNSUPPORTED");
    return true;
  });
});

test("an oversized file is refused rather than truncated", async () => {
  await fs.writeFile(shot("huge.png"), Buffer.alloc(2048));
  await assert.rejects(registry.register(shot("huge.png"), "filesystem"), (error) => {
    assert.equal(error.code, "TOO_LARGE");
    assert.match(error.message, /2048 bytes/);
    return true;
  });
});

test("a missing file is NOT_FOUND", async () => {
  await assert.rejects(registry.register(shot("nope.png"), "filesystem"), (error) => {
    assert.equal(error.code, "NOT_FOUND");
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * The index
 * ------------------------------------------------------------------ */

test("registrations survive a restart", async () => {
  const ref = await registry.register(shot("notes.md"), "filesystem");

  const reopened = new MediaRegistry({ mediaDir, maxBytes: 1024 });
  await reopened.load();

  const found = reopened.get(ref.id);
  assert.ok(found, "the index should be reloaded from disk");
  assert.equal(found.filename, "notes.md");
  assert.equal(found.sha256, ref.sha256);
});

test("an index entry whose file has been deleted is dropped, not served", async () => {
  const ref = await registry.register(shot("notes.md"), "filesystem");
  await fs.rm(ref.localMediaPath);

  const reopened = new MediaRegistry({ mediaDir, maxBytes: 1024 });
  await reopened.load();

  assert.equal(reopened.get(ref.id), undefined, "a registration must not outlive its bytes");
});

test("removing an attachment deletes the stored copy", async () => {
  await fs.writeFile(shot("temp.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
  const ref = await registry.register(shot("temp.png"), "filesystem");

  assert.equal(await registry.remove(ref.id), true);
  assert.equal(registry.get(ref.id), undefined);
  await assert.rejects(fs.stat(ref.localMediaPath));
  assert.equal(await registry.remove(ref.id), false, "removing twice is not an error");
});

test("cleanup honours a retention window (spec §86)", async () => {
  const retentionDir = path.join(sandbox, "retention");
  const fresh = new MediaRegistry({ mediaDir: retentionDir, maxBytes: 1024 });

  await fs.writeFile(shot("old.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]));
  const ref = await fresh.register(shot("old.png"), "filesystem");

  assert.equal(await fresh.cleanup(30), 0, "recent media is kept");
  assert.ok(fresh.get(ref.id));

  // Backdate the record rather than racing the clock: comparing against
  // "now minus zero days" is a sub-millisecond coin flip, which made this
  // test pass alone and fail in a full run.
  const indexPath = path.join(retentionDir, "index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  index.items[0].registeredAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(indexPath, JSON.stringify(index));

  const reopened = new MediaRegistry({ mediaDir: retentionDir, maxBytes: 1024 });
  assert.equal(await reopened.cleanup(30), 1, "media older than the window is removed");
  assert.equal(reopened.get(ref.id), undefined);
  await assert.rejects(fs.stat(ref.localMediaPath), "the bytes go too, not just the record");
});
