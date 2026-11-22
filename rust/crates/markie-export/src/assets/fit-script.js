
(function () {
  function fit() {
    var article = document.querySelector("article.markdown-body");
    if (!article) return;
    var max = article.clientWidth;
    var body = getComputedStyle(document.body);
    var pageHeight = 1122.5 - parseFloat(body.paddingTop) - parseFloat(body.paddingBottom);
    var blocks = article.querySelectorAll("table, pre, .katex-display, img, p.markie-embed");
    for (var i = 0; i < blocks.length; i += 1) {
      var el = blocks[i];
      var width = el.scrollWidth;
      if (width > max + 1) el.style.zoom = String(Math.max(0.4, max / width));
      if (el.getBoundingClientRect().height > pageHeight * 0.5) el.style.breakInside = "auto";
    }
  }
  function whenReady(run) {
    var loaded = document.readyState === "complete"
      ? Promise.resolve()
      : new Promise(function (resolve) { window.addEventListener("load", resolve, { once: true }); });
    var fonts = (document.fonts && document.fonts.ready) || Promise.resolve();
    Promise.all([loaded, Promise.resolve(fonts)]).then(run, run);
  }
  whenReady(fit);
})();
