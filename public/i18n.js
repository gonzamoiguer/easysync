// UI strings for the screens around playback (home, picker, start gate,
// errors). The playback HUD stays in English on purpose.
// Language comes from the browser/system; anything not listed falls back to English.

const strings = {
  en: {
    create: 'CREATE ROOM',
    code: 'CODE',
    join: 'JOIN',
    tipChrome: 'TIP: CHROME OR EDGE PLAY BIG VIDEO FILES IN PLACE. THIS BROWSER COPIES THE FILE INTO ITS STORAGE FIRST.',
    help: 'SETUP / HELP',
    room: 'ROOM',
    host: 'HOST',
    guest: 'GUEST',
    hostNote: 'HOST — YOUR VIDEO SETS THE LOOP LENGTH',
    pick: 'PICK VIDEO FILE',
    saving: 'SAVING A COPY IN THE BROWSER {p}%',
    leave: 'LEAVE',
    cantOpen: 'COULD NOT OPEN THAT FILE',
    cantPlay: 'THIS BROWSER CANNOT PLAY {name}',
    notFound: 'VIDEO NOT FOUND: {name}',
    clickToStart: 'CLICK TO START',
    skipFirefox: 'TO SKIP THIS NEXT TIME: CLICK THE ICON LEFT OF THE ADDRESS → AUTOPLAY → ALLOW AUDIO AND VIDEO.',
    skipSafari: 'TO SKIP THIS NEXT TIME: SAFARI → SETTINGS FOR THIS WEBSITE → AUTO-PLAY → ALLOW ALL AUTO-PLAY.',
    skipChrome: 'TO SKIP THIS NEXT TIME: START CHROME IN KIOSK MODE. SEE SETUP / HELP.',
    taken: 'ROOM {room} IS USED BY ANOTHER HOST',
    noRoom: 'ROOM {room} DOES NOT EXIST',
    or: 'OR',
  },
  es: {
    create: 'CREAR SALA',
    code: 'CÓDIGO',
    join: 'UNIRSE',
    tipChrome: 'CONSEJO: CHROME O EDGE REPRODUCEN VIDEOS GRANDES DIRECTO DEL DISCO. ESTE NAVEGADOR PRIMERO COPIA EL ARCHIVO A SU ALMACENAMIENTO.',
    help: 'CONFIGURACIÓN / AYUDA',
    room: 'SALA',
    host: 'ANFITRIÓN',
    guest: 'INVITADO',
    hostNote: 'ANFITRIÓN — TU VIDEO DEFINE LA DURACIÓN DEL LOOP',
    pick: 'ELEGIR ARCHIVO DE VIDEO',
    saving: 'GUARDANDO UNA COPIA EN EL NAVEGADOR {p}%',
    leave: 'SALIR',
    cantOpen: 'NO SE PUDO ABRIR ESE ARCHIVO',
    cantPlay: 'ESTE NAVEGADOR NO PUEDE REPRODUCIR {name}',
    notFound: 'VIDEO NO ENCONTRADO: {name}',
    clickToStart: 'CLIC PARA EMPEZAR',
    skipFirefox: 'PARA SALTAR ESTO LA PRÓXIMA VEZ: CLIC EN EL ÍCONO A LA IZQUIERDA DE LA DIRECCIÓN → REPRODUCCIÓN AUTOMÁTICA → PERMITIR AUDIO Y VIDEO.',
    skipSafari: 'PARA SALTAR ESTO LA PRÓXIMA VEZ: SAFARI → AJUSTES DE ESTE SITIO WEB → REPRODUCCIÓN AUTOMÁTICA → PERMITIR TODO.',
    skipChrome: 'PARA SALTAR ESTO LA PRÓXIMA VEZ: INICIA CHROME EN MODO KIOSCO. VER CONFIGURACIÓN / AYUDA.',
    taken: 'LA SALA {room} ESTÁ EN USO POR OTRO ANFITRIÓN',
    noRoom: 'LA SALA {room} NO EXISTE',
    or: 'Ó',
  },
};

export const lang =
  (navigator.languages || [navigator.language])
    .map((l) => String(l).slice(0, 2).toLowerCase())
    .find((l) => l in strings) || 'en';

document.documentElement.lang = lang;

export function t(key, vars = {}) {
  const s = strings[lang][key] ?? strings.en[key];
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
}
