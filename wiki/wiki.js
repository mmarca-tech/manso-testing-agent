// Sidebar active-link highlighting on scroll. Diagrams are pre-rendered PNGs
// (see diagrams/), so the wiki needs no network or external scripts to display.
const links = Array.from(document.querySelectorAll(".sidebar a[href^='#']"));
if (links.length > 0) {
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          links.forEach((a) => a.classList.remove("active"));
          const a = byId.get(e.target.id);
          if (a) a.classList.add("active");
        }
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  document.querySelectorAll("section[id]").forEach((s) => observer.observe(s));
}
