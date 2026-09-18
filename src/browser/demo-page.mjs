export function researchPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Example Research</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #111827; background: #fff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    header { height: 94px; display: flex; align-items: center; justify-content: space-between; padding: 0 56px; border-bottom: 1px solid #d7dde4; }
    .brand { font: 700 34px/1 Georgia, serif; color: #111; }
    nav { display: flex; gap: 38px; align-items: center; font-size: 15px; }
    nav a { color: #15191f; text-decoration: none; }
    .search { border: 0; background: transparent; width: 32px; height: 32px; font-size: 20px; cursor: pointer; }
    main { padding: 44px 56px 64px; }
    .hero { display: grid; grid-template-columns: minmax(360px, 0.95fr) minmax(420px, 1.05fr); gap: 54px; align-items: center; }
    .label { color: #175ddc; font-size: 13px; font-weight: 750; letter-spacing: .08em; }
    h1 { margin: 18px 0; max-width: 560px; font: 500 48px/1.02 Georgia, serif; letter-spacing: -.025em; }
    .intro { margin: 0 0 30px; max-width: 550px; color: #4b5563; font-size: 18px; line-height: 1.65; }
    .actions { display: flex; align-items: center; gap: 30px; }
    .primary { border: 0; border-radius: 6px; color: white; background: #1764df; padding: 15px 22px; font: 650 16px/1 system-ui; cursor: pointer; box-shadow: 0 8px 22px rgba(23,100,223,.18); }
    .secondary { color: #1764df; text-decoration: none; font-weight: 600; }
    .photo { width: 100%; aspect-ratio: 1.55; object-fit: cover; border-radius: 5px; display: block; }
    .areas { margin-top: 46px; }
    h2 { margin: 0 0 18px; font: 500 28px/1.15 Georgia, serif; }
    .area-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
    .area { min-height: 190px; padding: 22px; border: 1px solid #e1e5ea; border-radius: 7px; background: #fff; }
    .area-icon { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 18px; color: #1764df; background: #eef4ff; font-weight: 800; }
    .area h3 { margin: 0 0 10px; font-size: 16px; }
    .area p { color: #667085; font-size: 14px; line-height: 1.5; min-height: 44px; }
    .area button { border: 0; padding: 0; background: none; color: #1764df; cursor: pointer; font-weight: 600; }
    #status { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(100px); padding: 11px 16px; color: white; background: #111827; border-radius: 7px; transition: transform .2s ease; }
    #status.show { transform: translateX(-50%) translateY(0); }
    @media (max-width: 800px) { header { padding: 0 24px; } nav a { display: none; } main { padding: 28px 24px; } .hero { grid-template-columns: 1fr; } .area-grid { grid-template-columns: 1fr 1fr; } h1 { font-size: 40px; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">Example Research</div>
    <nav aria-label="Research navigation">
      <a href="#areas">Topics</a><a href="#areas">Publications</a><a href="#about">About</a><a href="#contact">Contact</a>
      <button class="search" aria-label="Search research">⌕</button>
    </nav>
  </header>
  <main>
    <section class="hero" id="about">
      <div>
        <div class="label">RESEARCH</div>
        <h1>Advancing knowledge through rigorous research</h1>
        <p class="intro">We conduct interdisciplinary research to address complex challenges and drive meaningful innovation.</p>
        <div class="actions">
          <button class="primary" id="explore">Explore our work &nbsp;→</button>
          <a class="secondary" href="#areas">View publications &nbsp;›</a>
        </div>
      </div>
      <img class="photo" src="http://chimera.local/assets/research-mountain.svg" alt="Code-authored mountain landscape beneath a dawn sky" />
    </section>
    <section class="areas" id="areas">
      <h2>Featured areas</h2>
      <div class="area-grid">
        <article class="area"><div class="area-icon">AI</div><h3>Artificial Intelligence</h3><p>Building reliable, safe, and beneficial AI systems.</p><button>Learn more &nbsp;→</button></article>
        <article class="area"><div class="area-icon">SE</div><h3>Sustainability</h3><p>Developing solutions for a sustainable future.</p><button>Learn more &nbsp;→</button></article>
        <article class="area"><div class="area-icon">BIO</div><h3>Biotechnology</h3><p>Advancing biology and medicine through innovation.</p><button>Learn more &nbsp;→</button></article>
        <article class="area"><div class="area-icon">PP</div><h3>Public Policy</h3><p>Informing policy through evidence-based research.</p><button>Learn more &nbsp;→</button></article>
      </div>
    </section>
  </main>
  <div id="status" role="status">Research workspace updated</div>
  <script>
    const status = document.querySelector('#status');
    const announce = (text) => { status.textContent = text; status.classList.add('show'); setTimeout(() => status.classList.remove('show'), 1600); };
    document.querySelector('#explore').addEventListener('click', () => { document.querySelector('#areas').scrollIntoView({behavior:'smooth'}); announce('Showing featured research areas'); });
    document.querySelector('.search').addEventListener('click', () => announce('Search is ready for human input'));
    document.querySelectorAll('.area button').forEach((button) => button.addEventListener('click', () => announce(button.closest('.area').querySelector('h3').textContent + ' selected')));
  </script>
</body>
</html>`
}

export function developmentsPageHtml() {
  return researchPageHtml()
    .replaceAll('Example Research', 'Latest AI Developments')
    .replace('Advancing knowledge through rigorous research', 'Tracking the systems shaping applied AI')
    .replace('We conduct interdisciplinary research to address complex challenges and drive meaningful innovation.', 'A focused briefing on reliable agents, model routing, evaluation, and human oversight.')
}
