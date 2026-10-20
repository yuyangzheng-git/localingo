/* Local assets only: compatible with the server's Content Security Policy.
 * Interactive macOS-style demo window + light scroll motion for the landing page. */
(function () {
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── Demo window: close / minimize / zoom states ─────────────────── */
  var stage = document.querySelector(".demo-stage");
  if (stage) {
    var demo = stage.querySelector(".reading-demo");
    var dock = stage.querySelector(".demo-dock");
    var backdrop = document.querySelector(".demo-backdrop");
    var btnClose = stage.querySelector(".win-close");
    var btnMin = stage.querySelector(".win-min");
    var btnZoom = stage.querySelector(".win-zoom");

    function setState(state) {
      stage.dataset.state = state;
      demo.classList.toggle("is-closed", state === "closed");
      demo.classList.toggle("is-minimized", state === "minimized");
      demo.classList.toggle("is-zoomed", state === "zoomed");
      stage.classList.toggle("is-restore", state === "closed" || state === "minimized");
      document.body.classList.toggle("is-locked", state === "zoomed");
      if (backdrop) backdrop.classList.toggle("is-on", state === "zoomed");
      if (state !== "default") {
        stage.style.setProperty("--tilt-x", "0deg");
        stage.style.setProperty("--tilt-y", "0deg");
      }
    }

    if (btnClose) btnClose.addEventListener("click", function () { setState("closed"); });
    if (btnMin) btnMin.addEventListener("click", function () { setState("minimized"); });
    if (btnZoom) btnZoom.addEventListener("click", function () {
      setState(stage.dataset.state === "zoomed" ? "default" : "zoomed");
    });
    if (dock) dock.addEventListener("click", function () {
      setState("default");
      if (btnZoom) btnZoom.focus();
    });
    if (backdrop) backdrop.addEventListener("click", function () { setState("default"); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && stage.dataset.state === "zoomed") setState("default");
    });

    /* macOS titlebar behaviour: double-click toggles zoom. */
    var toolbar = stage.querySelector(".demo-toolbar");
    if (toolbar) {
      toolbar.addEventListener("dblclick", function (e) {
        if (e.target.closest(".win-light")) return;
        setState(stage.dataset.state === "zoomed" ? "default" : "zoomed");
      });
    }

    /* Subtle 3D tilt while hovering the window. */
    if (!reduceMotion) {
      stage.addEventListener("mousemove", function (e) {
        if (stage.dataset.state !== "default") return;
        var r = stage.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        stage.style.setProperty("--tilt-x", (py * -4).toFixed(2) + "deg");
        stage.style.setProperty("--tilt-y", (px * 5).toFixed(2) + "deg");
      });
      stage.addEventListener("mouseleave", function () {
        stage.style.setProperty("--tilt-x", "0deg");
        stage.style.setProperty("--tilt-y", "0deg");
      });
    }
  }

  /* ── Scroll reveal for sections, mark swipe when demo is in view ── */
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  var demoEl = document.querySelector(".reading-demo");
  function showAll() {
    reveals.forEach(function (el) { el.classList.add("is-in"); });
    if (demoEl) demoEl.classList.add("is-ready");
  }
  if (reduceMotion || !("IntersectionObserver" in window)) {
    showAll();
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        if (entry.target === demoEl) entry.target.classList.add("is-ready");
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -30px 0px" });
    reveals.forEach(function (el) { io.observe(el); });
    if (demoEl) io.observe(demoEl);
  }
})();
