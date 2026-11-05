// Nav shading and in-page smooth scrolling. Replaces jQuery and its plugins.
(function () {
    var nav = document.querySelector('nav');

    function markNav() {
        if (!nav) {
            return;
        }
        var offset = window.pageYOffset || document.documentElement.scrollTop;
        nav.classList.toggle('black', offset > 0);
    }

    window.addEventListener('scroll', markNav, { passive: true });
    markNav();

    var links = document.querySelectorAll('a[href^="#"]');
    for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function (event) {
            var hash = this.getAttribute('href');
            if (!hash || hash === '#') {
                return;
            }
            var target = document.getElementById(hash.slice(1));
            if (!target) {
                return;
            }
            event.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (history.pushState) {
                history.pushState(null, '', hash);
            }
        });
    }
})();
