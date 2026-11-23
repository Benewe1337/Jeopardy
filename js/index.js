// Startseite: Raumcode eingeben und beitreten (eigene Datei statt Inline-Skript wegen CSP).
document.getElementById('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('code').value.trim().toUpperCase();
  if (code) location.href = 'player.html?room=' + encodeURIComponent(code);
});
