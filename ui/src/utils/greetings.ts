export const GREETINGS: Array<{ en: string; ru: string }> = [
  { en: "What masterpiece are we avoiding today?", ru: "Какой шедевр мы избегаем сегодня?" },
  { en: "Type first. Spiral later.", ru: "Сначала пиши. Паниковать будешь потом." },
  { en: "Your overthinking assistant is online.", ru: "Твой ассистент по гиперобдумыванию онлайн." },
  { en: "Welcome back to productive chaos, {name}.", ru: "С возвращением в продуктивный хаос, {name}." },
  { en: "Go ahead. Make it weird.", ru: "Давай. Сделай это странным." },
  { en: "This chat has seen worse ideas.", ru: "Этот чат видел идеи и похуже." },
  { en: "Tiny steps. Huge delusions.", ru: "Маленькие шаги. Огромные амбиции." },
  { en: "You bring the confusion, I'll bring the words.", ru: "Ты приноси хаос, я принесу слова." },
  { en: "Procrastination with extra features.", ru: "Прокрастинация с дополнительными функциями." },
  { en: "Tell me the plan you'll ignore tomorrow.", ru: "Расскажи план, который завтра проигнорируешь." },
  { en: "No pressure. Just your entire future.", ru: "Без давления. Только всё твоё будущее." },
  { en: "Brain buffering… please type something.", ru: "Мозг загружается… напиши хоть что-нибудь." },
  { en: "Let's turn caffeine into progress.", ru: "Давай превратим кофеин в прогресс." },
  { en: "Bad ideas welcome. Great ideas suspicious.", ru: "Плохим идеям рады. Хорошие вызывают подозрение." },
  { en: "Another beautiful day to overcomplicate things, {name}.", ru: "Ещё один прекрасный день всё усложнять, {name}." },
  { en: "What are we dramatically overreacting to today?", ru: "На что мы сегодня драматично реагируем?" },
  { en: "Start typing before motivation disappears.", ru: "Начни писать, пока мотивация не испарилась." },
  { en: "You think. I pretend to understand.", ru: "Ты думаешь. Я делаю вид, что понимаю." },
  { en: "Insert existential crisis here.", ru: "Вставьте экзистенциальный кризис сюда." },
  { en: "Welcome, {name}. Chaos is a valid workflow.", ru: "Добро пожаловать, {name}. Хаос — это тоже рабочий процесс." },
  { en: "Your tab count is between us, {name}.", ru: "Количество твоих вкладок останется между нами, {name}." },
  { en: "Let's fake confidence together.", ru: "Давай вместе изображать уверенность." },
  { en: "One more \"quick question,\" huh?", ru: "Ещё один «быстрый вопрос», да?" },
  { en: "Be honest: are we working or avoiding work?", ru: "Честно: мы работаем или избегаем работы?" },
  { en: "I support your last-minute decisions, {name}.", ru: "Я поддерживаю твои решения в последний момент, {name}." },
];

const STORAGE_KEY = "agentchat.greetingIdx";

function getStoredIdx(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const n = Number(stored);
      if (!Number.isNaN(n) && n >= 0 && n < GREETINGS.length) return n;
    }
  } catch { /* ignore */ }
  return null;
}

function storeIdx(idx: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(idx)); } catch { /* ignore */ }
}

export function pickGreeting(name?: string): string {
  let idx = getStoredIdx();
  if (idx === null) {
    idx = Math.floor(Math.random() * GREETINGS.length);
    storeIdx(idx);
  }
  let phrase = GREETINGS[idx]!.en;
  if (name) phrase = phrase.replace(/\{name\}/g, name);
  return phrase;
}
