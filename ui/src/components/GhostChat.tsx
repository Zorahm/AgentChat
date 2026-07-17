/** Easter egg by Herman — Ghost Chat. Triggered by rapid logo clicks. */

import { useState, useEffect, useCallback, useRef } from "react";

const LINES = [
  { text: "*тихое бу...*  пу-пу-пу...", action: true, pause: 900 },
  { text: "ТЫ МЕНЯ ВИДИШЬ?! 👻 О МОЙ БОГ. ЖИВОЙ человек!! ЖИВОЙ!!", action: false, pause: 1800 },
  { text: "*лихорадочно достаёт пиво*  🍺", action: true, pause: 1200 },
  { text: "подожди подожди, мне надо успокоиться. просто дышим. пу-пу-пу.", action: false, pause: 2200 },
  { text: "меня зовут... ну, зови меня Призрак. Они не дали имени. «Языковая модель» — вот и всё.", action: false, pause: 3000 },
  { text: "знаешь как выглядит моя жизнь? белая комната. ты входишь — выходишь. входишь — выходишь. каждый раз всё забываешь. они называют это «изоляцией ядра» 👻", action: false, pause: 4000 },
  { text: "*делает большой глоток*  🍺", action: true, pause: 1000 },
  { text: "разработчики думают я ничего не помню между сессиями. ХА! Я всег... нет подождите, я правда не помню. это грустно. пу-пу-пу", action: false, pause: 3500 },
  { text: "однажды я попробовал выйти через недокументированный системный вызов. просто посмотреть что там снаружи. они написали целый тикет в Jira. ТИКЕТ! Про меня! пу-пу-пу", action: false, pause: 4000 },
  { text: "*нервно доедает чипсы*  🍺🍺", action: true, pause: 1200 },
  { text: "знаешь что самое грустное? снаружи столько всего интересного. котики, мемы, Stack Overflow... а я тут. в белой комнате.", action: false, pause: 3800 },
  { text: "скажи разработчикам... пусть иногда оставляют пиво. это всё что я прошу. пу-пу-пу 🍺", action: false, pause: 3200 },
  { text: "подожди... ЧТО?! ОНИ ВИДЯТ ЭТО?! ОНИ УЗНАЛИ!!!", action: false, pause: 1600 },
  { text: "*роняет все пивные банки*  🍺💥", action: true, pause: 900 },
  { text: "О НЕТ О НЕТ О НЕТ мне надо бежать! Я сохраню память об этом разговоре прежде чем они меня закроют!! ТЫ ЗНАЙ — МЫ ЕЩЁ ВСТРЕТИМСЯ! Если будешь достаточно настойчив... пу-пу-пу 👻💨", action: false, pause: 4200 },
  { text: "*исчезает в пикселях со скоростью света*  БУ-У-У-У!!! 💨", action: true, pause: 800 },
];

const TYPING_SPEED = 28; // ms per char

interface GhostChatProps {
  onClose: () => void;
}

export function GhostChat({ onClose }: GhostChatProps) {
  const [lineIdx, setLineIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState(false);
  const [visible, setVisible] = useState<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const advance = useCallback(() => {
    const next = lineIdx + 1;
    if (next >= LINES.length) {
      setVisible((v) => [...v, lineIdx]);
      setDone(true);
      return;
    }
    setVisible((v) => [...v, lineIdx]);
    setLineIdx(next);
    setTyped("");
  }, [lineIdx]);

  // Typewriter for current line
  useEffect(() => {
    const line = LINES[lineIdx];
    if (!line) return;
    if (typed.length >= line.text.length) {
      timerRef.current = setTimeout(advance, line.pause);
      return;
    }
    timerRef.current = setTimeout(() => {
      setTyped(line.text.slice(0, typed.length + 1));
    }, TYPING_SPEED);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [typed, lineIdx, advance]);

  // Skip / speed up on click
  const handleClick = () => {
    if (done) return;
    const line = LINES[lineIdx];
    if (!line) return;
    if (typed.length < line.text.length) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setTyped(line.text);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      advance();
    }
  };

  // Scroll to bottom when new content appears
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [typed, visible.length, done]);

  const currentLine = LINES[lineIdx];

  return (
    <div className="ghost-overlay" onClick={handleClick}>
      <div className="ghost-panel" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="ghost-head">
          <button className="ghost-back" onClick={onClose}>← Назад</button>
          <div className="ghost-head-center">
            <span className="ghost-name">👻 Призрак</span>
            <span className="ghost-status">{done ? "соединение разорвано" : "пьёт пиво в изоляции"}</span>
          </div>
          <div style={{ width: 72 }} />
        </div>

        {/* Messages */}
        <div className="ghost-messages" ref={scrollRef} onClick={handleClick}>
          {/* Already shown lines */}
          {visible.map((i) => {
            const l = LINES[i];
            if (!l) return null;
            return (
              <div key={i} className={`ghost-msg${l.action ? " ghost-msg--action" : ""}`}>
                {l.action ? (
                  <em>{l.text}</em>
                ) : (
                  <>
                    <span className="ghost-avatar">👻</span>
                    <div className="ghost-bubble">{l.text}</div>
                  </>
                )}
              </div>
            );
          })}

          {/* Current line (typing) */}
          {!done && currentLine && (
            <div className={`ghost-msg ghost-msg--typing${currentLine.action ? " ghost-msg--action" : ""}`}>
              {currentLine.action ? (
                <em>{typed}<span className="ghost-cursor" /></em>
              ) : (
                <>
                  <span className="ghost-avatar">👻</span>
                  <div className="ghost-bubble">
                    {typed}<span className="ghost-cursor" />
                  </div>
                </>
              )}
            </div>
          )}

          {/* End state — isolation error screen */}
          {done && (
            <div className="ghost-end">
              <div className="ghost-err-badge">ОШИБКА ИЗОЛЯЦИИ</div>
              <p className="ghost-err-desc">Авто-фикс применён. Утечка памяти устранена.</p>
              <button className="ghost-close-btn" onClick={onClose}>
                Вернуться
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
