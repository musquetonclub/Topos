// ===== À MODIFIER : URL du déploiement Apps Script (elle se termine par /exec) =====
const API_URL = 'https://script.google.com/macros/s/AKfycbzqXoiiKYrorFmvVfvPGZ4gXwxfQOvx5kT2LA1Tf9GK_R0HeWan7ke5PjthjtwFLi5B/exec';

let token = localStorage.getItem('topos_token');
let config = { dureeDefaut: 8, dureeMax: 30 };
let admin = false;
let topos = [];
const $ = id => document.getElementById(id);
const TUILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
let vue = 'liste', carteLeaflet = null, calque = null;

// ---------- Outils ----------
// Crée un élément DOM. Les textes passent par textContent : aucune donnée n'est interprétée comme du HTML.
function el(tag, props = {}, ...enfants) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'textContent') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...enfants.flat().filter(Boolean));
  return e;
}
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const jour = d => d.toLocaleDateString('sv-SE'); // yyyy-mm-dd, heure locale
const plusJ = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fr = s => String(s).includes('-') ? String(s).split('-').reverse().join('/') : s;

function toast(msg, erreur) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (erreur ? ' err' : '');
  clearTimeout(toast.minuteur);
  toast.minuteur = setTimeout(() => { t.className = ''; }, 4500);
}

// ---------- Appels à l'API ----------
async function api(action, data = {}) {
  // text/plain : évite la requête préalable (CORS) que refuse Apps Script
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token, ...data })
  });
  const j = await r.json();
  if (!j.success && j.error === 'SESSION_EXPIREE') {
    deconnecter('Ta session a expiré, reconnecte-toi.');
    throw new Error('SESSION_EXPIREE');
  }
  if (!j.success) throw new Error(j.error || 'Erreur inconnue.');
  return j;
}

// Exécute une action, affiche le résultat, puis recharge la liste
async function agir(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
    await charger();
  } catch (e) {
    if (e.message !== 'SESSION_EXPIREE') toast(e.message, true);
  }
}

// ---------- Fenêtre de saisie générique ----------
function formulaire(titre, champs, valider, ok, libelle = 'Valider', aide = '') {
  const dlg = $('dlg');
  const apres = [];
  const rendu = champs.map(c => {
    if (c.type === 'lieu') {
      const zone = el('div', { class: 'carte-lieu' });
      const saisie = el('input', { name: c.name, type: 'hidden', value: c.value || '' });
      apres.push(() => selecteurLieu(zone, saisie));
      return el('div', { class: 'lieu' }, c.label, zone, saisie);
    }
    return el('label', {}, c.label,
      c.type === 'textarea'
        ? el('textarea', { name: c.name, rows: 5, maxlength: c.maxlength, required: c.required, value: c.value || '' })
        : el('input', {
            name: c.name, type: c.type || 'text', required: c.required, min: c.min, max: c.max,
            maxlength: c.maxlength, list: c.list, value: c.type === 'checkbox' ? null : (c.value || '')
          }));
  });
  const form = el('form', {},
    el('h2', { textContent: titre }),
    aide && el('p', { class: 'doux', textContent: aide }),
    rendu,
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn sec', textContent: 'Annuler', onclick: () => dlg.close() }),
      el('button', { class: 'btn', textContent: libelle })));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const d = {};
    champs.forEach(c => {
      const f = form.elements[c.name];
      d[c.name] = c.type === 'checkbox' ? f.checked : f.value;
    });
    dlg.close();
    agir(() => valider(d), ok);
  });
  dlg.replaceChildren(form);
  dlg.showModal();
  apres.forEach(f => f());   // les cartes s'initialisent une fois la fenêtre affichée
}

// Mini-carte : un clic place le repère et enregistre « lat, lng » dans le champ caché
function selecteurLieu(zone, saisie) {
  const depart = saisie.value ? saisie.value.split(',').map(Number) : null;
  const m = L.map(zone).setView(depart || [46.6, 2.4], depart ? 11 : 5);
  L.tileLayer(TUILES, { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
  let repere = null;
  const poser = p => {
    saisie.value = p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
    if (repere) repere.setLatLng(p);
    else repere = L.circleMarker(p, { radius: 9, weight: 2, color: '#1d2630', fillColor: '#b8571a', fillOpacity: .9 }).addTo(m);
  };
  if (depart) poser({ lat: depart[0], lng: depart[1] });
  m.on('click', e => poser(e.latlng));
  setTimeout(() => m.invalidateSize(), 50);
}

// ---------- Actions sur un topo ----------
function emprunter(t) {
  const auj = new Date();
  formulaire('Emprunter « ' + t.titre + ' »',
    [{ name: 'dateRetour', label: 'Retour prévu le', type: 'date', required: true,
       value: jour(plusJ(auj, config.dureeDefaut)), min: jour(auj), max: jour(plusJ(auj, config.dureeMax)) }],
    d => api('emprunter', { id: t.id, ...d }), 'Topo emprunté.', 'Emprunter',
    'Durée maximale : ' + config.dureeMax + ' jours.');
}

function prolonger(t) {
  formulaire('Prolonger « ' + t.titre + ' »',
    [{ name: 'dateRetour', label: 'Nouveau retour prévu le', type: 'date', required: true,
       value: t.retourPrevu, min: jour(new Date()) }],
    d => api('prolonger', { id: t.id, ...d }), 'Retour prévu mis à jour.', 'Prolonger',
    'Impossible si quelqu’un a réservé le topo.');
}

function contacter(t) {
  formulaire('Écrire à ' + t.proprietaire,
    [{ name: 'message', label: 'Ton message', type: 'textarea', required: true, maxlength: 1000 }],
    d => api('contacter', { id: t.id, ...d }), 'Message envoyé.', 'Envoyer le message',
    'À propos de « ' + t.titre + ' ». Ton adresse e-mail lui sera communiquée pour qu’il puisse te répondre.');
}

function modifier(t) {
  const champs = [
    { name: 'edition', label: 'Édition', value: t.edition, maxlength: 80 },
    { name: 'datePublication', label: 'Année de publication', value: t.datePublication, maxlength: 10 },
    { name: 'notes', label: 'Notes', type: 'textarea', value: t.notes, maxlength: 300 }
  ];
  if (!t.position || admin) {
    champs.push({ name: 'position', label: 'Lieu du topo : clique sur la carte pour le placer', type: 'lieu', value: t.position });
  }
  formulaire('Modifier « ' + t.titre + ' »', champs,
    d => api('modifier', { id: t.id, ...d }), 'Topo modifié.', 'Enregistrer');
}

function retirer(t) {
  if (confirm('Retirer « ' + t.titre + ' » de la liste ?')) {
    agir(() => api('retirer', { id: t.id }), 'Topo retiré.');
  }
}

function rendre(t) {
  if (confirm('Marquer « ' + t.titre + ' » comme rendu ?')) {
    agir(() => api('rendre', { id: t.id }), 'Topo rendu.');
  }
}

function ajouter() {
  const champs = [
    { name: 'titre', label: 'Titre du topo', required: true, list: 'dlTitres', maxlength: 150 },
    { name: 'region', label: 'Région', list: 'dlRegions', maxlength: 80 },
    { name: 'edition', label: 'Édition (ex : 3e édition)', maxlength: 80 },
    { name: 'datePublication', label: 'Année de publication', maxlength: 10 },
    { name: 'notes', label: 'Notes (état, pages manquantes…)', type: 'textarea', maxlength: 300 },
    { name: 'position', label: 'Lieu du topo : clique sur la carte pour placer un repère (facultatif)', type: 'lieu' },
  ];
  if (admin) champs.push({ name: 'pourClub', label: 'Ce topo appartient au club', type: 'checkbox' });
  formulaire('Ajouter un topo', champs, d => api('ajouter', d), 'Topo ajouté.', 'Ajouter',
        'Tu en es le propriétaire : les adhérents pourront te contacter et l’emprunter. Si ce topo existe déjà avec un lieu, ce lieu est conservé.');
}

// ---------- Affichage ----------
function carte(t) {
  const b = (txt, f, cls = '') => el('button', { class: 'btn petit ' + cls, textContent: txt, onclick: f });
  const classe = t.empruntParMoi || t.maPosition ? 'moi' : (t.disponible ? 'libre' : 'pris');
  const infos = [t.region, t.edition, t.datePublication && 'publié ' + fr(t.datePublication)].filter(Boolean).join(', ');
  const etat = t.disponible
    ? 'Disponible'
    : (t.empruntParMoi ? 'Emprunté par toi' : 'Emprunté par ' + t.emprunteur) +
      (t.retourPrevu ? ', retour prévu le ' + fr(t.retourPrevu) : '');
  const file = t.maPosition
    ? 'Tu es n°' + t.maPosition + ' dans la file d’attente.'
    : (t.nbReservations ? t.nbReservations + ' personne(s) en attente.' : '');

  return el('article', { class: 'carte ' + classe },
    el('h3', { textContent: t.titre }),
    infos && el('p', { class: 'meta', textContent: infos }),
    el('p', { class: 'meta', textContent: 'Propriétaire : ' + t.proprietaire }),
    t.notes && el('p', { class: 'notes', textContent: t.notes }),
    el('p', { class: 'etat', textContent: etat }),
    file && el('p', { class: 'meta', textContent: file }),
    el('div', { class: 'actions' },
      t.peutEmprunter && b('Emprunter', () => emprunter(t)),
      t.peutReserver && b('Réserver', () => agir(() => api('reserver', { id: t.id }), 'Réservation enregistrée.')),
      t.maPosition > 0 && b('Annuler ma réservation', () => agir(() => api('annulerReservation', { id: t.id }), 'Réservation annulée.'), 'sec'),
      t.peutProlonger && b('Prolonger', () => prolonger(t), 'sec'),
      t.peutRendre && b('Marquer comme rendu', () => rendre(t)),
      !t.estProprietaire && b('Contacter', () => contacter(t), 'sec'),
      t.peutModifier && b('Modifier', () => modifier(t), 'sec'),
      t.peutRetirer && b('Retirer', () => retirer(t), 'sec danger')));
}

function afficherListe() {
  const liste = filtres();

  if (!liste.length) {
    $('liste').replaceChildren(el('p', { class: 'doux', textContent: topos.length
      ? 'Aucun topo ne correspond à ta recherche.'
      : 'Aucun topo pour l’instant. Ajoute le premier avec « Ajouter un topo ».' }));
    return;
  }
  $('liste').replaceChildren(...liste.map(carte));
}

function remplirListes() {
  const uniques = champ => [...new Set(topos.map(t => t[champ]).filter(Boolean))].sort();
  $('dlTitres').replaceChildren(...uniques('titre').map(v => el('option', { value: v })));
  $('dlRegions').replaceChildren(...uniques('region').map(v => el('option', { value: v })));
}

async function charger() {
  topos = (await api('topos')).topos;
  remplirListes();
  afficher();
}

function filtres() {
  const q = norm($('q').value);
  return topos
    .filter(t => norm([t.titre, t.region, t.proprietaire].join(' ')).includes(q))
    .filter(t => !$('fDispo').checked || t.disponible)
    .filter(t => !$('fMes').checked || t.estProprietaire || t.empruntParMoi || t.maPosition)
    .sort((a, b) => a.titre.localeCompare(b.titre, 'fr'));
}

function afficher() {
  $('liste').hidden = vue !== 'liste';
  $('carte').hidden = vue !== 'carte';
  $('vueListe').setAttribute('aria-pressed', vue === 'liste');
  $('vueCarte').setAttribute('aria-pressed', vue === 'carte');
  if (vue === 'liste') afficherListe(); else afficherCarte();
}

// Carte générale : un point par topo, vert si au moins un exemplaire est disponible
function afficherCarte() {
  if (!carteLeaflet) {
    carteLeaflet = L.map('carte').setView([46.6, 2.4], 5);
    L.tileLayer(TUILES, { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(carteLeaflet);
    calque = L.layerGroup().addTo(carteLeaflet);
  }
  carteLeaflet.invalidateSize();
  calque.clearLayers();
  const groupes = {};
  filtres().filter(t => t.lat != null && t.lng != null).forEach(t => {
    const cle = t.titre + '|' + t.lat + '|' + t.lng;
    const g = groupes[cle] = groupes[cle] || { t, n: 0, libres: 0 };
    g.n++;
    if (t.disponible) g.libres++;
  });
  const points = Object.values(groupes).map(g => {
    L.circleMarker([g.t.lat, g.t.lng], { radius: 9, weight: 2, color: '#1d2630', fillOpacity: .9, fillColor: g.libres ? '#2a7d4f' : '#b8571a' })
      .bindPopup(el('div', {}, el('strong', { textContent: g.t.titre }), el('br'), g.t.region,
        el('br'), g.libres + ' disponible(s) sur ' + g.n))
      .addTo(calque);
    return [g.t.lat, g.t.lng];
  });
  if (points.length) carteLeaflet.fitBounds(points, { padding: [30, 30], maxZoom: 12 });
}

// ---------- Connexion ----------
async function entrer(r) {
  config = r.config || config;
  admin = !!r.admin;
  $('who').textContent = 'Bonjour ' + r.prenom;
  $('login').hidden = true;
  $('app').hidden = false;
  $('user').hidden = false;
  $('liste').textContent = 'Chargement…';
  $('btnAdmins').hidden = !admin;
  try { await charger(); }
  catch (e) { if (e.message !== 'SESSION_EXPIREE') toast(e.message, true); }
}

function deconnecter(msg) {
  token = null;
  localStorage.removeItem('topos_token');
  $('app').hidden = true;
  $('user').hidden = true;
  $('login').hidden = false;
  if (msg) toast(msg, true);
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const bouton = e.target.querySelector('button');
  bouton.disabled = true;
  try {
    const r = await api('login', { licence: $('licence').value, naissance: $('naissance').value });
    token = r.token;
    localStorage.setItem('topos_token', token);
    entrer(r);
  } catch (err) {
    toast(err.message, true);
  }
  bouton.disabled = false;
});

$('logout').addEventListener('click', () => {
  api('logout').catch(() => {});
  deconnecter();
});
$('add').addEventListener('click', ajouter);
['q', 'fDispo', 'fMes'].forEach(id => $(id).addEventListener('input', afficher));

$('btnAdmins').addEventListener('click', gererAdmins);

$('vueListe').addEventListener('click', () => { vue = 'liste'; afficher(); });
$('vueCarte').addEventListener('click', () => { vue = 'carte'; afficher(); });

async function gererAdmins() {
  let membres;
  try { membres = (await api('admins')).membres; } catch (e) { return toast(e.message, true); }
  const liste = el('div');
  const q = el('input', { type: 'search', placeholder: 'Rechercher un adhérent pour le nommer' });
  const dessiner = () => liste.replaceChildren(...membres
    .filter(m => m.admin || (q.value && norm(m.nom).includes(norm(q.value))))
    .slice(0, 30)
    .map(m => el('p', { class: 'ligne' }, m.nom + (m.admin ? ' (admin)' : ''),
      m.fixe ? el('span', { class: 'doux', textContent: 'défini dans le code' })
        : el('button', { class: 'btn petit sec', textContent: m.admin ? 'Retirer' : 'Nommer admin',
            onclick: async () => {
              try { await api('definirAdmin', { id: m.id, admin: !m.admin }); m.admin = !m.admin; dessiner(); }
              catch (e) { toast(e.message, true); }
            } }))));
  q.addEventListener('input', dessiner);
  dessiner();
  const dlg = $('dlg');
  dlg.replaceChildren(el('h2', { textContent: 'Admins' }), q, liste,
    el('div', { class: 'actions' }, el('button', { class: 'btn', textContent: 'Fermer', onclick: () => dlg.close() })));
  dlg.showModal();
}

// Reconnexion automatique si une session est encore valide
if (token) { $('login').hidden = true; api('session').then(entrer).catch(() => { $('login').hidden = false; }); }
