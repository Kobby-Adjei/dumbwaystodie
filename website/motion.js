(() => {
  "use strict";

  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");

  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let textureFrame = 0;
  let textureFramesRemaining = 0;

  function paintTexture() {
    currentX += (targetX - currentX) * 0.14;
    currentY += (targetY - currentY) * 0.14;

    const settled =
      (Math.abs(targetX - currentX) < 0.002 && Math.abs(targetY - currentY) < 0.002) ||
      textureFramesRemaining <= 1;

    if (settled) {
      currentX = targetX;
      currentY = targetY;
    }

    root.style.setProperty("--texture-x", `${(currentX * 10).toFixed(2)}px`);
    root.style.setProperty("--texture-y", `${(currentY * 8).toFixed(2)}px`);
    root.style.setProperty("--grain-x", `${(currentX * -6).toFixed(2)}px`);
    root.style.setProperty("--grain-y", `${(currentY * -6).toFixed(2)}px`);

    textureFramesRemaining -= 1;
    if (settled) {
      textureFrame = 0;
      return;
    }

    textureFrame = requestAnimationFrame(paintTexture);
  }

  function moveTexture(x, y) {
    targetX = x;
    targetY = y;
    textureFramesRemaining = 40;
    if (!textureFrame) textureFrame = requestAnimationFrame(paintTexture);
  }

  if (!reduceMotion.matches && finePointer.matches) {
    window.addEventListener(
      "pointermove",
      (event) => {
        moveTexture(
          event.clientX / window.innerWidth - 0.5,
          event.clientY / window.innerHeight - 0.5,
        );
      },
      { passive: true },
    );
    document.documentElement.addEventListener("pointerleave", () => moveTexture(0, 0));
  }

  const diagram = document.querySelector(".flow-diagram");
  const svg = diagram?.querySelector(".routes");
  const sourceNode = diagram?.querySelector("[data-source-node]");
  const hubNode = diagram?.querySelector("[data-hub-node]");
  const sourceRoute = diagram?.querySelector("[data-source-route]");
  const routesGroup = diagram?.querySelector("[data-model-routes]");
  const packet = diagram?.querySelector("[data-packet]");
  const models = diagram ? Array.from(diagram.querySelectorAll("[data-model]")) : [];
  const status = diagram?.querySelector(".flow-status");
  const statusKind = diagram?.querySelector("[data-flow-kind]");
  const statusCopy = diagram?.querySelector("[data-flow-copy]");

  if (!diagram || !svg || !sourceNode || !hubNode || !sourceRoute || !routesGroup || !packet || !status || !statusKind || !statusCopy || !models.length) {
    return;
  }

  const namespace = "http://www.w3.org/2000/svg";
  const modelRoutes = models.map(() => {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("class", "route route-model");
    routesGroup.append(path);
    return path;
  });

  function anchorOf(element) {
    const frame = diagram.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left - frame.left + rect.width / 2,
      y: rect.top - frame.top + rect.height / 2,
      radius: Math.min(rect.width, rect.height) / 2 + 3,
    };
  }

  function straightLine(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    const startX = from.x + ux * from.radius;
    const startY = from.y + uy * from.radius;
    const endX = to.x - ux * to.radius;
    const endY = to.y - uy * to.radius;
    return `M ${startX.toFixed(2)} ${startY.toFixed(2)} L ${endX.toFixed(2)} ${endY.toFixed(2)}`;
  }

  function drawRoutes() {
    const source = anchorOf(sourceNode.querySelector(":scope > svg"));
    const hub = anchorOf(hubNode.querySelector(".hub-mark"));
    sourceRoute.setAttribute("d", straightLine(source, hub));
    models.forEach((model, index) => {
      modelRoutes[index].setAttribute("d", straightLine(hub, anchorOf(model.querySelector("img"))));
    });
  }

  function pointAlong(path, progress, reverse = false) {
    const length = path.getTotalLength();
    return path.getPointAtLength(length * (reverse ? 1 - progress : progress));
  }

  function movePacket(path, progress, reverse = false) {
    const point = pointAlong(path, progress, reverse);
    packet.setAttribute("cx", point.x.toFixed(2));
    packet.setAttribute("cy", point.y.toFixed(2));
  }

  let lastModel = -1;
  let lastPhase = "";
  let diagramFrame = 0;
  const cycleLength = 4300;

  function setDiagramState(index, phase) {
    if (index !== lastModel) {
      models.forEach((model, modelIndex) => model.classList.toggle("is-active", modelIndex === index));
      modelRoutes.forEach((route, routeIndex) => {
        route.classList.toggle("is-active", routeIndex === index);
        if (routeIndex !== index) route.classList.remove("is-returning");
      });
      lastModel = index;
    }

    if (phase === lastPhase) return;
    const returning = phase === "answer-model" || phase === "answer-editor";
    packet.classList.toggle("is-returning", returning);
    status.classList.toggle("is-returning", returning);
    sourceRoute.classList.toggle("is-active", phase === "context-bridge" || phase === "answer-editor");
    sourceRoute.classList.toggle("is-returning", phase === "answer-editor");
    modelRoutes[index].classList.toggle("is-returning", returning);

    statusKind.textContent = returning ? "answer" : "context";
    statusCopy.textContent = returning
      ? `${models[index].dataset.model} → DWTD → your coding agent`
      : `Your coding agent → DWTD → ${models[index].dataset.model}`;
    lastPhase = phase;
  }

  function animateDiagram(time) {
    const cycle = Math.floor(time / cycleLength);
    const index = cycle % models.length;
    const progress = (time % cycleLength) / cycleLength;
    let phase;

    if (progress < 0.24) {
      phase = "context-bridge";
      setDiagramState(index, phase);
      movePacket(sourceRoute, progress / 0.24);
    } else if (progress < 0.58) {
      phase = "context-model";
      setDiagramState(index, phase);
      movePacket(modelRoutes[index], (progress - 0.24) / 0.34);
    } else if (progress < 0.72) {
      phase = "answer-model";
      setDiagramState(index, phase);
      movePacket(modelRoutes[index], 1);
    } else if (progress < 0.88) {
      phase = "answer-model";
      setDiagramState(index, phase);
      movePacket(modelRoutes[index], (progress - 0.72) / 0.16, true);
    } else {
      phase = "answer-editor";
      setDiagramState(index, phase);
      movePacket(sourceRoute, (progress - 0.88) / 0.12, true);
    }

    diagramFrame = requestAnimationFrame(animateDiagram);
  }

  drawRoutes();
  new ResizeObserver(drawRoutes).observe(diagram);

  if (reduceMotion.matches) {
    setDiagramState(0, "context-model");
    movePacket(modelRoutes[0], 0.5);
  } else {
    diagramFrame = requestAnimationFrame(animateDiagram);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && diagramFrame) {
        cancelAnimationFrame(diagramFrame);
        diagramFrame = 0;
      } else if (!document.hidden && !diagramFrame) {
        diagramFrame = requestAnimationFrame(animateDiagram);
      }
    });
  }
})();
