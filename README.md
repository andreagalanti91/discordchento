# Signal Desk

Legge un canale Discord di segnali di trading 24/7 dal tuo Mac, estrae ogni mossa (entry, DCA, take parziali, stop a BE), la mette nel contesto di mercato, la riesegue sulle candele reali e mostra tutto in una dashboard locale in stile Apple.

Costruito e tarato sul canale ScalpX di Chento (BTCUSDT perp, livelli di liquidità), ma il canale si cambia con due variabili d'ambiente.

```
Discord (Chrome locale, profilo dedicato)
   │  risposte REST del client + DOM observer, solo lettura
   ▼
collector ──► SQLite (data/desk.db) ──► parser ──► analyzer ──► SSE ──► dashboard :4777
                                           │            │
                                           ▼            ▼
                                  replica (1m Binance)  Claude (opzionale: testo + screenshot)
                                  bot Liquidity Levels
                                  ottimizzatori
```

## Requisiti

- macOS, Node.js ≥ 22.5 (usa `node:sqlite`), Google Chrome installato
- Un account Discord che vede il canale

## Setup

```bash
npm install
cp .env.example .env
```

```bash
npm run login
```

Si apre Chrome con un profilo dedicato (`data/chrome-profile`). Fai login a Discord lì (il QR dall'app è il più veloce): il tool scarica tutto lo storico del canale e si chiude. Il login resta salvato in quel profilo; nessun token viene estratto o scritto.

```bash
npm start
```

Dashboard su http://localhost:4777. Con `HEADLESS=1` Chrome gira nascosto.

### Sempre attivo (24/7)

```bash
npm run service
```

Installa un LaunchAgent (`com.signaldesk.agent`): parte al login, si riavvia se cade, e `caffeinate` impedisce lo stop del Mac mentre è attaccato alla corrente. Per toglierlo: `npm run service:stop`. Log in `data/desk.log`.

### Analisi con Claude (opzionale)

Metti `ANTHROPIC_API_KEY` in `.env`. Ogni nuovo messaggio, con i suoi screenshot, viene letto da Claude (`CLAUDE_MODEL`, default `claude-opus-5-5`) che restituisce in JSON: sintesi, azione, livelli, lettura delle immagini, rischi e un consiglio. Senza key l'analisi è a regole (sempre attiva).

## Cosa fa

| Modulo | File |
|---|---|
| Lettura canale: storico e live, download immagini | `src/collector.js` |
| Parser del gergo del canale ("taking 80.4 and 79.6", "take 25% both", "sl be", pesi del ladder) | `src/parser.js` |
| Analisi per messaggio: contesto (trend, ATR, cluster pivot), piano Desk, notifica macOS | `src/analyzer.js` |
| Replica "copia il canale" su candele 1m, con varianti | `src/replica.js` |
| Bot meccanico Liquidity Levels + ottimizzatore walk-forward | `src/levels.js`, `src/optimize.js` |
| Report per la dashboard (`data/research.json`) | `src/research.js` |
| Server, API, SSE | `src/server.js` |
| Dashboard | `dashboard/index.html` |

`data/declared.json` contiene le posizioni degli screenshot exchange trascritte a mano (dichiarate dal canale, non verificabili).

## Le tre strategie

I livelli arrivano tutti da Chento; cambia chi li esegue e come.

| | Segnale Discord | Chento | Desk |
|---|---|---|---|
| Chi | chi copia i post alla lettera | il trader sul suo conto (stima) | la nostra versione |
| Entry | limit al prezzo scritto | livelli anticipati di ~$100 | livelli anticipati di $150 |
| Uscite | i "take X%" dei messaggi | a discrezione, come posta | BE +0.8%, 50% a +0.8%, resto a +1.5% |
| Stop | solo se scritto | "placeholder" | 2.5% fisso |

La dashboard ha cinque sezioni: **Oggi** (l'ultimo segnale letto nei tre modi), **Strategie**, **Confronto**, **Laboratorio** e **Messaggi**.

Il **Confronto** ha due finestre:
- **Storico**: su questo periodo sono state tarate le regole di Desk.
- **Test live**: parte alla prima esecuzione di questa versione (`forward_start` nel database) e conta solo i segnali successivi, su cui nessuna strategia è stata tarata.

## Bot Desk (paper trading)

Il bot gioca la strategia Desk su un **conto simulato** (default 10.000 $) con i prezzi live di Binance. Non collega nessun exchange e non invia ordini reali: le notifiche dicono cosa farebbe, e puoi replicarlo a mano.

- **Taglia:** ogni campagna rischia `BOT_RISK_PCT` del conto se scatta lo stop (default 1% = 100 $). Un DCA aggiunge 0,5%, con un massimo del 2% e 3 ingressi.
- **Uscite:** stop al 2,5% dal medio, breakeven a +0,8%, metà a +0,8%, poi trailing 0,7%. Sullo storico il trailing ha battuto il TP2 fisso in entrambe le metà.
- **Messaggi del canale:** segue "chiudi" e "sl be" perché riducono il rischio; ignora i take parziali.
- **Freni:**
  - stop giornaliero a −3% (nessuna nuova entry fino al giorno UTC successivo);
  - pausa a −15% dal massimo, finché non lo riattivi dalla dashboard;
  - esposizione massima 10×.
- **Continuità:** lo stato è salvato in SQLite. Dopo un riavvio, o se il Mac va in stop, il bot rielabora le candele perse.
- **Stesso codice ovunque:** il replay sullo storico (`npm run bot:replay`) usa la stessa macchina a stati del live. Sullo storico fa +3,2% su 9 campagne, con drawdown massimo 1,3%.
- **Telegram:** notifiche di ogni piano, esecuzione, uscita e allarme. I fill e gli eventi minori arrivano senza suono. Il bot risponde solo alla tua chat con `/stato`, `/posizioni`, `/trade`, `/segnale`, `/pausa`, `/riattiva`, `/aiuto`. Funziona in long polling, quindi nulla del Mac è esposto su Internet.
  1. Su Telegram apri **@BotFather** → `/newbot` → scegli nome e username.
  2. Incolla il token nel `.env` dopo `TELEGRAM_BOT_TOKEN=`.
  3. Lancia `npm run telegram:setup`, apri il link che stampa e premi **Avvia**: il chat id viene salvato da solo.
  4. Riavvia il servizio: `launchctl kickstart -k gui/$(id -u)/com.signaldesk.agent`.
- **ntfy (alternativa):** imposta `NTFY_TOPIC` con un nome lungo e casuale; chiunque conosca il topic può leggerlo.

Tutti i parametri sono in `.env.example` (`BOT_*`).

## Risultati storici (29 set – 22 ott 2026)

Rendimenti per entry con nozionale = 1× capitale, fee incluse.

| Strategia | Rend. | Max DD | Note |
|---|---|---|---|
| Segnale Discord | +1.5% | 4.9% | 5 entry su 12 mai eseguite su Binance |
| Chento (stima) | +10.1% | 6.8% | frontrun $100 e la sua gestione |
| **Desk** | **+10.0%** | **3.1%** | livelli del canale, uscite meccaniche |
| BTC buy & hold | −3.1% | — | |

- **Frontrun**: è la variabile che conta di più.
- **Bot meccanico**: 2.500 configurazioni su un anno. Il migliore fa +8.8R in train e −5.7R nel test fuori campione: i cluster pivot da soli non bastano, il valore sta nei livelli scelti dal trader.
- **Campione piccolo** (8 campagne eseguite): la config Desk è scelta sull'intero storico. La validazione vera è il forward test, che il tool aggiorna a ogni nuovo messaggio.
- Gli screenshot del canale mostrano solo posizioni in profitto, con ROE sul margine a 30–50x.

Non è consulenza finanziaria.

## Comandi

| | |
|---|---|
| `npm run login` | login + download storico |
| `npm start` | collector + analisi + dashboard |
| `npm run dashboard` | solo dashboard (senza Discord) |
| `npm run research` | ricalcola tutti i backtest |
| `npm run parse:check` | stampa gli eventi estratti da ogni messaggio |
| `npm run bot:replay` | rigioca lo storico attraverso il bot e stampa operazioni e notifiche |
| `npm run bot:test` | scenari di test del bot (stop, freni, override del canale) |
| `npm run telegram:setup` | collega la tua chat Telegram al bot |

## Note

L'automazione di un account utente è una zona grigia dei Termini di Discord. Il tool legge soltanto, con il ritmo di un client normale, ma il rischio sull'account resta tuo. L'alternativa conforme è un bot ufficiale, se sei admin del server.
