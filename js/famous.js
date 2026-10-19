// Famous players: default bots and style references, built from their OTB games in PGN Mentor's database.
// `elo` is only a fallback for games recorded without ratings (anything before FIDE ratings, ~1970);
// estimates follow the usual historical-rating reconstructions and the bot's own strength fit corrects them.
const FAMOUS = [
  { id: 'morphy', name: 'Paul Morphy', file: 'Morphy', elo: 2690, era: '1850s', note: 'American prodigy, the era\'s unofficial world champion. Rapid development and open lines.', hue: 24 },
  { id: 'capablanca', name: 'José Raúl Capablanca', file: 'Capablanca', elo: 2725, era: 'World Champion 1921–27', note: 'Effortless simplicity and legendary endgame technique.', hue: 200 },
  { id: 'alekhine', name: 'Alexander Alekhine', file: 'Alekhine', elo: 2690, era: 'World Champion 1927–35, 1937–46', note: 'Deep, fierce combinational attacker.', hue: 350 },
  { id: 'botvinnik', name: 'Mikhail Botvinnik', file: 'Botvinnik', elo: 2690, era: 'World Champion 1948–63 (with breaks)', note: 'Patriarch of the Soviet school; scientific preparation.', hue: 215 },
  { id: 'tal', name: 'Mikhail Tal', file: 'Tal', elo: 2700, era: 'World Champion 1960–61', note: 'The Magician from Riga. Speculative sacrifices and wild complications.', hue: 280 },
  { id: 'petrosian', name: 'Tigran Petrosian', file: 'Petrosian', elo: 2690, era: 'World Champion 1963–69', note: 'Master of prophylaxis and the positional exchange sacrifice.', hue: 160 },
  { id: 'spassky', name: 'Boris Spassky', file: 'Spassky', elo: 2690, era: 'World Champion 1969–72', note: 'A universal player at home in any kind of position.', hue: 45 },
  { id: 'fischer', name: 'Bobby Fischer', file: 'Fischer', elo: 2785, era: 'World Champion 1972–75', note: 'Precise, classical openings and relentless winning will.', hue: 0 },
  { id: 'karpov', name: 'Anatoly Karpov', file: 'Karpov', elo: 2720, era: 'World Champion 1975–85', note: 'The positional boa constrictor.', hue: 190 },
  { id: 'kasparov', name: 'Garry Kasparov', file: 'Kasparov', elo: 2800, era: 'World Champion 1985–2000', note: 'Dynamic preparation and the initiative above all.', hue: 330 },
  { id: 'polgar', name: 'Judit Polgar', file: 'PolgarJ', elo: 2700, era: 'Peak #8 in the world', note: 'The strongest female player in history; an aggressive attacker.', hue: 300 },
  { id: 'anand', name: 'Viswanathan Anand', file: 'Anand', elo: 2780, era: 'World Champion 2007–13', note: 'Lightning-fast and flexible.', hue: 30 },
  { id: 'kramnik', name: 'Vladimir Kramnik', file: 'Kramnik', elo: 2780, era: 'World Champion 2000–07', note: 'Solid technique; brought the Berlin Defence to the top level.', hue: 230 },
  { id: 'carlsen', name: 'Magnus Carlsen', file: 'Carlsen', elo: 2830, era: 'World Champion 2013–23', note: 'Grinds the smallest edges into wins.', hue: 210 },
  { id: 'nakamura', name: 'Hikaru Nakamura', file: 'Nakamura', elo: 2780, era: 'Top-ranked US grandmaster', note: 'Speed-chess virtuoso with a fighting style.', hue: 260 },
  { id: 'caruana', name: 'Fabiano Caruana', file: 'Caruana', elo: 2800, era: 'World #2 for years', note: 'Deep preparation and stamina.', hue: 140 },
];

// Source spec for a legend's bot: their most recent classical OTB games
const famousSource = f => ({ kind: 'otb', file: f.file, name: f.name, tc: 'classical', recent: 300, elo: f.elo, famous: f.id });

// Monogram avatar (no outside photos): initials on a colored disc
function initials(name) {
  const parts = name.replace(/\(.*\)/, '').trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}
function avatarHtml({ name, img, hue = 210, size = 44, crown = false }) {
  const inner = img ? `<img src="${esc(img)}" alt="" onerror="this.remove()">` : '';
  return `<span class="avatar" style="--av:${size}px;--hue:${hue}">${inner}<span class="av-txt">${esc(initials(name))}</span>${crown ? '<span class="av-crown" title="World champion">♛</span>' : ''}</span>`;
}
const hueOf = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
