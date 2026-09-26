// Keep navigation independent of the SVG replaced by live job updates.
export function mountWorkflowViewport(viewport, {zoomIn, zoomOut, fitButton, level}) {
  const window = viewport.ownerDocument.defaultView;
  const events = new window.AbortController();
  const on = (target, name, callback, options = {}) =>
    target.addEventListener(name, callback, {...options, signal: events.signal});
  let drawing, key, width = 0, height = 0, scale = 1, x = 0, y = 0;
  let fitted = true, size = {width: 0, height: 0}, drag = null, suppressClick = false;
  const measure = () => ({width: viewport.clientWidth, height: viewport.clientHeight});
  const fitScale = () => Math.min(1, Math.max(1, size.width - 32) / width,
    Math.max(1, size.height - 32) / height);
  const minimum = () => Math.min(.05, fitScale() / 4);
  function paint() {
    if (!drawing) return;
    drawing.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    const label = `${(scale * 100).toFixed(scale < .1 ? 1 : 0)}%`;
    if (level.textContent !== label) level.textContent = label;
    zoomIn.disabled = scale >= 4;
    zoomOut.disabled = scale <= minimum();
  }
  function fit() {
    fitted = true;
    size = measure();
    if (!drawing || !size.width || !size.height) return;
    scale = fitScale();
    x = (size.width - width * scale) / 2;
    y = (size.height - height * scale) / 2;
    paint();
  }
  function zoom(factor, at = {x: size.width / 2, y: size.height / 2}) {
    if (!drawing) return;
    const next = Math.max(minimum(), Math.min(4, scale * factor));
    x = at.x - (at.x - x) * next / scale;
    y = at.y - (at.y - y) * next / scale;
    scale = next; fitted = false; paint();
  }
  on(zoomIn, 'click', () => zoom(1.3));
  on(zoomOut, 'click', () => zoom(1 / 1.3));
  on(fitButton, 'click', fit);
  on(viewport, 'wheel', event => {
    if (!drawing) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
    zoom(Math.exp(-Math.max(-300, Math.min(300, delta)) * .002),
      {x: event.clientX - rect.left, y: event.clientY - rect.top});
  }, {passive: false});
  on(viewport, 'pointerdown', event => {
    if (event.button !== 0 || !drawing || drag) return;
    suppressClick = false;
    drag = {id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y, moved: false};
  });
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = drag.moved;
    if (viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
    drag = null; viewport.classList.remove('is-panning');
  }
  on(window, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true; viewport.setPointerCapture(drag.id);
      viewport.classList.add('is-panning');
    }
    event.preventDefault();
    x = drag.x + dx; y = drag.y + dy; fitted = false; paint();
  }, {passive: false});
  on(window, 'pointerup', finish);
  on(window, 'pointercancel', finish);
  on(viewport, 'lostpointercapture', finish);
  on(viewport, 'click', event => {
    if (suppressClick) {suppressClick = false; event.preventDefault(); event.stopPropagation();}
  }, {capture: true});
  on(viewport, 'keydown', event => {
    if (event.target !== viewport || !drawing) return;
    if (['+', '='].includes(event.key)) zoom(1.3);
    else if (event.key === '-') zoom(1 / 1.3);
    else if (['0', 'Home'].includes(event.key)) fit();
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const step = event.shiftKey ? 150 : 50;
      if (event.key === 'ArrowLeft') x += step;
      if (event.key === 'ArrowRight') x -= step;
      if (event.key === 'ArrowUp') y += step;
      if (event.key === 'ArrowDown') y -= step;
      fitted = false; paint();
    } else return;
    event.preventDefault();
  });
  const observer = new window.ResizeObserver(() => {
    const next = measure();
    if (!next.width || !next.height) return;
    if (fitted) fit();
    else {x += (next.width - size.width) / 2; y += (next.height - size.height) / 2; size = next; paint();}
  });
  observer.observe(viewport);
  return {
    update(svg, bounds, identity) {
      drawing = svg; width = bounds.width; height = bounds.height;
      if (key !== identity) {key = identity; fit();}
      else paint();
    },
    clear() {drawing = null; key = undefined; fitted = true;},
    dispose() {
      observer.disconnect();
      events.abort();
    },
  };
}
