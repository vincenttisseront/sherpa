
<template>
  <div class="auth">
    <aside class="hero" aria-hidden="true">
      <div class="hero-brand">
        <AppLogo :size="48" />
        <span class="name"><strong>Sherpa</strong><small>Déploiements Docker par SSH</small></span>
      </div>
      <div class="pitch">
        <h2>Déployez sereinement sur tous vos serveurs Docker.</h2>
      </div>
    </aside>
    <main class="panel">
      <div class="box">
        <div class="brand-mobile"><AppLogo :size="40" /><strong>Sherpa</strong></div>
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.auth { min-height: 100vh; display: grid; grid-template-columns: minmax(380px, 46%) 1fr; background: var(--bg); }
.hero {
  position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between;
  padding: var(--space-7); color: #fff;
  background: radial-gradient(circle at 15% 15%, rgb(163 92 240 / 55%), transparent 45%), radial-gradient(circle at 85% 80%, rgb(79 91 213 / 65%), transparent 50%), #0f1630;
}
.hero::after { content: ''; position: absolute; inset: 0; background-image: radial-gradient(rgb(255 255 255 / 7%) 1px, transparent 1px); background-size: 22px 22px; pointer-events: none; }
.hero > * { position: relative; z-index: 1; }
.hero-brand, .brand-mobile { display: flex; align-items: center; gap: var(--space-3); font-size: 17px; }
.name { display: flex; flex-direction: column; line-height: 1.25; }
.name strong { font-size: 19px; letter-spacing: -0.01em; }
.name small { color: rgb(255 255 255 / 62%); font-size: 12.5px; }
.pitch h2 { font-size: 30px; line-height: 1.2; font-weight: 650; max-width: 440px; letter-spacing: -0.02em; }
.pitch ul { list-style: none; padding: 0; margin: var(--space-5) 0 0; display: flex; flex-direction: column; gap: var(--space-3); color: rgb(255 255 255 / 82%); }
.pitch li { display: flex; gap: var(--space-3); align-items: center; }
.foot { color: rgb(255 255 255 / 50%); }
.panel { display: grid; place-items: center; padding: var(--space-5); }
.box { width: min(420px, 100%); display: flex; flex-direction: column; gap: var(--space-4); }
.brand-mobile { display: none; }
@media (max-width: 900px) {
  .auth { grid-template-columns: 1fr; }
  .hero { display: none; }
  .brand-mobile { display: flex; margin-bottom: var(--space-3); }
}
</style>
