// Theme vor dem ersten Rendern setzen (eigene Datei statt Inline-Skript wegen CSP).
try { document.documentElement.dataset.theme = localStorage.getItem('jeopardy.theme') || 'graphit'; } catch (e) {}
