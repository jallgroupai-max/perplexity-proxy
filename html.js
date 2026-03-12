const hiddenStyles = `
<style id="mirror-ui-cleanup">
  [data-testid="header-download-app-button"],
  [data-testid="header-sign-up-button"],
  [data-testid="header-log-in-button"] {
    display: none !important;
  }

  /* Upgrade plan block */
  div.w-full.py-xs.border-subtlest.ring-subtlest.divide-subtlest:has(button:has(use[xlink\\:href="#pplx-icon-circle-arrow-up"])) {
    display: none !important;
  }
  div.w-full.overflow-hidden:has(button:has(use[xlink\\:href="#pplx-icon-circle-arrow-up"])) {
    display: none !important;
  }

  /* Floating upgrade banner */
  div.w-full.absolute.z-30.top-4.left-1\\/2.-translate-x-1\\/2:has(button:has(use[xlink\\:href="#pplx-icon-arrow-right"])) {
    display: none !important;
  }

  /* Profile footer and account actions */
  div.mt-auto.w-full.min-w-0,
  div.group\\/sidebar-bottom-item,
  button[aria-label="Notifications"] {
    display: none !important;
  }
</style>
`;

const lockProfileScript = `
<script id="mirror-profile-lock">
(function () {
  function hideElement(el) {
    if (!el) return;
    el.setAttribute('data-mirror-profile-locked', '1');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  function lockUi() {
    document.querySelectorAll('button').forEach((btn) => {
      const txt = (btn.textContent || '').trim().toLowerCase();
      if (txt.includes('upgrade plan')) {
        hideElement(btn.closest('div.w-full.py-xs') || btn.closest('div'));
      }
      if (txt.includes('upgrade to access the top ai models')) {
        hideElement(btn.closest('div.w-full.absolute.z-30') || btn.closest('div'));
      }
    });

    document.querySelectorAll('use[xlink\\:href="#pplx-icon-circle-arrow-up"]').forEach((iconUse) => {
      hideElement(iconUse.closest('div.w-full.overflow-hidden') || iconUse.closest('div.w-full.py-xs') || iconUse.closest('div'));
    });

    document.querySelectorAll('div.mt-auto.w-full.min-w-0').forEach(hideElement);
    document.querySelectorAll('div.group\\\\/sidebar-bottom-item').forEach(hideElement);
    document.querySelectorAll('button[aria-label=\"Notifications\"]').forEach((btn) => {
      hideElement(btn.closest('div.mt-auto.w-full.min-w-0') || btn.closest('div'));
    });

    document.querySelectorAll('img[alt=\"User avatar\"]').forEach((img) => {
      hideElement(img.closest('div.mt-auto.w-full.min-w-0') || img.closest('div'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', lockUi, { once: true });
  } else {
    lockUi();
  }

  const obs = new MutationObserver(() => lockUi());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
</script>
`;

module.exports = { hiddenStyles, lockProfileScript };
