/**
 * MESSAGES-UX-01 — synthetic data only (iteration 02). Every account, person, message, saved reply and translation
 * below is fictional and written for this prototype. "Lumen Coffee" is the same fictional brand as the Comments
 * Direction C prototype. Translations are illustrative fixtures written by hand — never generated, never verified.
 * Future-intelligence entries are hand-written illustrations; no analysis ever ran on anything.
 */
import { NOW, type Account, type Conversation, type Draft, type Lang, type SavedReply, type State, type Teammate } from "./model";

const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const H = 60;
const D = 24 * H;

export const ACCOUNTS: readonly Account[] = [
  { id: "a-ig", platform: "instagram", name: "Lumen Coffee", handle: "@lumen.coffee" },
  { id: "a-ig2", platform: "instagram", name: "Lumen Roastery", handle: "@lumen.roastery" },
  { id: "a-fb", platform: "messenger", name: "Lumen Coffee", handle: "Lumen Coffee" },
];

export const TEAM: readonly Teammate[] = [
  { id: "t-mara", name: "Mara Ortiz", initials: "MO" },
  { id: "t-carla", name: "Carla Méndez", initials: "CM" },
  { id: "t-bruno", name: "Bruno Díaz", initials: "BD" },
  { id: "t-ana", name: "Ana Torres", initials: "AT" },
];

export const ESCALATION_REASONS = ["Product or service issue", "Customer service", "Legal or reputation risk", "Needs client or owner decision", "Other"] as const;

const base = { request: false, escalation: null, partialHistory: false, presence: null, risk: null, events: [], notes: [] } as const;

const CONVERSATIONS: readonly Conversation[] = [
  {
    ...base,
    // A — Instagram, reply window open, assigned to me; reply-to, reaction, a seen receipt.
    id: "c-valen", accountId: "a-ig", lang: "en", participant: { name: "Valentina Cruz", handle: "valen.cafe", initials: "VC" }, state: "open", assignee: "t-mara", unreadFor: [],
    future: { intent: "Product question", urgency: "Low", tone: "Friendly", summary: "Asks which grind suits a moka pot and whether the 250 g bag ships today.", reasons: ["Question waiting for an answer", "Mentions an order she wants to place"], suggestion: "For a moka pot we recommend our medium-fine grind. Orders placed before 14:00 ship the same day!" },
    messages: [
      { id: "m1", dir: "in", at: ago(D + 3 * H), text: "Hi! Do you sell the Finca Las Nubes beans ground?" },
      { id: "m2", dir: "out", at: ago(D + 2 * H + 40), text: "Hi Valentina! Yes, we can grind any of our coffees for your brewing method. Which one do you use?", sender: "t-carla", receipt: "seen" },
      { id: "m3", dir: "in", at: ago(25), text: "A moka pot ☕ Which grind should I pick?", replyTo: "m2" },
      { id: "m4", dir: "in", at: ago(12), text: "And if I order the 250 g bag now, does it ship today?", reaction: "❤️" },
    ],
    notes: [{ id: "n1", at: ago(D + 2 * H), author: "t-carla", text: "Regular customer — usually buys the 250 g bag every month." }],
    events: [{ id: "e1", at: ago(D + 2 * H + 45), text: "Carla Méndez assigned the conversation to Mara Ortiz" }],
  },
  {
    ...base,
    // B — Messenger, several recent inbound messages, unassigned; marked as a synthetic high-risk example for Variant B.
    id: "c-pablo", accountId: "a-fb", lang: "en", participant: { name: "Pablo Ríos", initials: "PR" }, state: "open", assignee: null, unreadFor: ["t-mara", "t-carla", "t-bruno", "t-ana"],
    risk: "Synthetic high-risk example: a delayed-order complaint — check the promise before sending.",
    future: { intent: "Order status", urgency: "Medium", tone: "Impatient", summary: "Order #4821 hasn't arrived; three messages in 20 minutes.", reasons: ["Three unanswered messages", "Mentions a delayed order"], suggestion: "Hi Pablo, sorry for the wait! Could you confirm the email on order #4821 so we can check it right away?" },
    messages: [
      { id: "m1", dir: "in", at: ago(2 * D + 5 * H), text: "Hello, I placed order #4821 on Monday." },
      { id: "m2", dir: "out", at: ago(2 * D + 4 * H), text: "Thanks Pablo! It's being roasted and leaves tomorrow.", sender: "t-bruno", receipt: "seen" },
      { id: "m3", dir: "in", at: ago(28), text: "Hi again, the tracking still says 'label created'." },
      { id: "m4", dir: "in", at: ago(19), text: "It's been four days." },
      { id: "m5", dir: "in", at: ago(9), text: "Can someone check, please?" },
    ],
  },
  {
    ...base,
    // C — unread commercial inquiry in Spanish (incoming Spanish → English fixture).
    id: "c-hotel", accountId: "a-fb", lang: "es", participant: { name: "Hotel Andes · Compras", initials: "HA" }, state: "open", assignee: null, unreadFor: ["t-mara", "t-carla", "t-bruno", "t-ana"],
    future: { intent: "Commercial — wholesale", urgency: "High", tone: "Formal", summary: "Hotel purchasing team asks for a monthly wholesale quote (~40 kg, espresso).", reasons: ["Commercial intent: wholesale quote", "Volume mentioned (40 kg/month)", "No reply yet"], suggestion: "¡Gracias por escribirnos! Nuestro equipo mayorista les enviará hoy una cotización por 40 kg mensuales. ¿Nos comparten un email de contacto?" },
    messages: [
      { id: "m1", dir: "in", at: ago(47), lang: "es", text: "Hola, somos el equipo de compras del Hotel Andes. Buscamos un proveedor de café de especialidad para nuestro restaurante.", translations: { en: "Hi, we are the purchasing team at Hotel Andes. We are looking for a specialty coffee supplier for our restaurant." } },
      { id: "m2", dir: "in", at: ago(46), lang: "es", text: "Necesitaríamos unos 40 kg por mes, tueste para espresso. ¿Nos pueden enviar una cotización mayorista?", translations: { en: "We would need about 40 kg per month, espresso roast. Could you send us a wholesale quote?" } },
    ],
  },
  {
    ...base,
    // D — Done.
    id: "c-marina", accountId: "a-ig", lang: "en", participant: { name: "Marina Ferro", handle: "marina.f", initials: "MF" }, state: "done", assignee: "t-carla", unreadFor: [], future: null,
    messages: [
      { id: "m1", dir: "in", at: ago(D + 6 * H), text: "Does the free shipping apply to Uruguay too?" },
      { id: "m2", dir: "out", at: ago(D + 5 * H + 30), text: "Hi Marina! Free shipping covers Argentina and Uruguay for orders over $40.", sender: "t-carla", receipt: "seen" },
      { id: "m3", dir: "in", at: ago(D + 5 * H), text: "Perfect, thank you! 🙌" },
    ],
    notes: [{ id: "n1", at: ago(D + 4 * H + 50), author: "t-carla", text: "Answered; nothing else pending." }],
    events: [{ id: "e1", at: ago(D + 4 * H + 49), text: "Carla Méndez marked the conversation done" }],
  },
  {
    ...base,
    // E — the standard reply window closed (last message from the person 3 days ago).
    id: "c-joaquin", accountId: "a-ig", lang: "en", participant: { name: "Joaquín Rivas", handle: "joaquin.rv", initials: "JR" }, state: "open", assignee: "t-bruno", unreadFor: [],
    future: { intent: "Complaint", urgency: "Medium", tone: "Disappointed", summary: "Bag arrived damaged; the reply window closed before anyone answered.", reasons: ["Unanswered complaint", "Reply window closed"] },
    messages: [
      { id: "m1", dir: "in", at: ago(3 * D + 2 * H), text: "My bag arrived torn and half the beans spilled in the box." },
      { id: "m2", dir: "in", at: ago(3 * D + 2 * H - 1), attachments: [{ kind: "image", name: "photo.jpg", detail: "Photo", available: true }] },
    ],
    notes: [{ id: "n1", at: ago(2 * D), author: "t-bruno", text: "Missed this one — need to reach him another way (order email?)." }],
  },
  {
    ...base,
    // F — Messenger with attachments, one expired.
    id: "c-lucia", accountId: "a-fb", lang: "en", participant: { name: "Lucía Ferreyra", initials: "LF" }, state: "open", assignee: "t-ana", unreadFor: [],
    future: { intent: "Invoice request", urgency: "Low", tone: "Neutral", summary: "Needs an invoice for her company; sent the receipt.", reasons: ["Document attached", "Billing request"] },
    messages: [
      { id: "m1", dir: "in", at: ago(5 * H), text: "Hi! Could I get an invoice with my company's details? Receipt attached." },
      { id: "m2", dir: "in", at: ago(5 * H - 1), attachments: [{ kind: "file", name: "receipt-1123.pdf", detail: "PDF · 84 KB", available: true }] },
      { id: "m3", dir: "out", at: ago(4 * H), text: "Of course! Could you send your tax ID too?", sender: "t-ana", receipt: "delivered" },
      { id: "m4", dir: "in", at: ago(3 * H + 30), attachments: [{ kind: "image", name: "tax-id.png", detail: "Image", available: false }] },
      { id: "m5", dir: "in", at: ago(3 * H + 28), text: "Sent! 👆", edited: true },
    ],
  },
  {
    ...base,
    // G — another teammate is replying (simulated presence → collision warning).
    id: "c-rafa", accountId: "a-ig", lang: "en", participant: { name: "Rafa Molina", handle: "rafa.coffee", initials: "RM" }, state: "open", assignee: "t-bruno", unreadFor: ["t-mara"], presence: { who: "t-bruno", doing: "replying" },
    future: { intent: "Store information", urgency: "Low", tone: "Friendly", summary: "Asks for the Palermo store's Sunday hours.", reasons: ["Simple factual question"] },
    messages: [
      { id: "m1", dir: "in", at: ago(18), text: "Hey! Is the Palermo store open on Sundays?" },
      { id: "m2", dir: "in", at: ago(17), text: "Want to bring some friends for a tasting 🙂" },
    ],
  },
  {
    ...base,
    // H — older conversation: only recent messages are available (Instagram documents a 20-message limit).
    id: "c-beto", accountId: "a-ig2", lang: "en", participant: { name: "Beto Gómez", handle: "beto.gomez", initials: "BG" }, state: "open", assignee: null, unreadFor: [], escalation: { reason: "Product or service issue", to: "t-ana", note: "Recurring grinder issue — needs the roastery's answer." }, partialHistory: true,
    future: { intent: "Equipment issue", urgency: "Medium", tone: "Frustrated", summary: "Grinder bought in October still clogs; long-running thread.", reasons: ["Escalated", "Long thread"] },
    messages: [
      { id: "m1", dir: "native", at: ago(6 * D), text: "Hi Beto, we sent you a replacement burr set.", app: "the Instagram app" },
      { id: "m2", dir: "in", at: ago(2 * H), text: "The new burrs didn't fix it, the grinder still clogs with dark roasts." },
      { id: "m3", dir: "in", at: ago(2 * H - 3), unsent: true },
    ],
    notes: [{ id: "n1", at: ago(H), author: "t-mara", text: "@Ana can the roastery check the burr batch? Escalated to you." }],
    events: [{ id: "e1", at: ago(H - 1), text: "Mara Ortiz escalated to Ana Torres · Product or service issue" }],
  },
  {
    ...base,
    // A message request in Portuguese (incoming Portuguese → Spanish/English fixtures; outgoing Spanish → Portuguese draft).
    id: "c-nina", accountId: "a-ig", lang: "pt", participant: { name: "Nina Lab", handle: "nina.coffeelab", initials: "NL" }, request: true, state: "open", assignee: null, unreadFor: ["t-mara", "t-carla", "t-bruno", "t-ana"],
    future: { intent: "Partnership", urgency: "Low", tone: "Friendly", summary: "Coffee creator proposes a collaboration.", reasons: ["Message request", "Partnership proposal"] },
    messages: [
      {
        id: "m1", dir: "in", at: ago(70), lang: "pt", text: "Oi! Sou criadora de conteúdo sobre café. Topam uma parceria para um vídeo de degustação?",
        translations: { es: "¡Hola! Soy creadora de contenido sobre café. ¿Se animan a una colaboración para un video de degustación?", en: "Hi! I'm a coffee content creator. Would you be up for a partnership on a tasting video?" },
      },
    ],
  },
  {
    ...base,
    id: "c-ines", accountId: "a-fb", lang: "en", participant: { name: "Inés Paredes", initials: "IP" }, state: "done", assignee: "t-mara", unreadFor: [], future: null,
    messages: [
      { id: "m1", dir: "in", at: ago(2 * D + 3 * H), text: "Do you have decaf?" },
      { id: "m2", dir: "out", at: ago(2 * D + 2 * H), text: "We do! Our Swiss-water decaf from Colombia is back in stock.", sender: "t-mara", receipt: "seen" },
    ],
  },
  {
    ...base,
    id: "c-sol", accountId: "a-ig2", lang: "en", participant: { name: "Sol Márquez", handle: "sol.marquez", initials: "SM" }, state: "open", assignee: "t-carla", unreadFor: [], presence: { who: "t-carla", doing: "viewing" },
    future: { intent: "Product question", urgency: "Low", tone: "Neutral", summary: "Asks for the roast date on the current batch.", reasons: ["Question waiting for an answer"] },
    messages: [{ id: "m1", dir: "in", at: ago(3 * H + 10), text: "What's the roast date on the Huila batch you're selling now?" }],
  },
];

const V = (en: string, es: string, pt?: string) => [{ lang: "en" as const, text: en }, { lang: "es" as const, text: es }, ...(pt === undefined ? [] : [{ lang: "pt" as const, text: pt }])];

export const SAVED_REPLIES: readonly SavedReply[] = [
  {
    id: "s-ship", title: "Shipping times", category: "Shipping", account: null, shortcut: "/ship",
    variants: V(
      "Orders placed before 14:00 ship the same day. Delivery takes 1–3 business days in Buenos Aires and 3–5 elsewhere.",
      "Los pedidos hechos antes de las 14:00 salen el mismo día. La entrega tarda 1–3 días hábiles en Buenos Aires y 3–5 en el resto del país.",
      "Pedidos feitos antes das 14:00 são enviados no mesmo dia. A entrega leva de 1 a 3 dias úteis em Buenos Aires e de 3 a 5 nas demais regiões.",
    ),
  },
  {
    id: "s-order", title: "Ask for the order number", category: "Orders", account: null, shortcut: "/order",
    variants: V(
      "Sorry for the wait! Could you share your order number and the email you used, so we can check it right away?",
      "¡Perdón por la demora! ¿Nos pasás tu número de pedido y el email que usaste, así lo revisamos enseguida?",
      "Desculpe a demora! Pode nos enviar o número do pedido e o e-mail usado, para verificarmos agora mesmo?",
    ),
  },
  {
    id: "s-wholesale", title: "Wholesale — first reply", category: "Wholesale", account: null, shortcut: "/whole",
    variants: V(
      "Thank you for your interest! Our wholesale team will send you a quote today. Could you share a contact email and your expected monthly volume?",
      "¡Gracias por tu interés! Nuestro equipo mayorista te enviará una cotización hoy. ¿Nos compartís un email de contacto y el volumen mensual estimado?",
      "Obrigado pelo interesse! Nossa equipe de atacado enviará um orçamento hoje. Pode nos passar um e-mail de contato e o volume mensal estimado?",
    ),
  },
  {
    id: "s-hours", title: "Palermo store hours", category: "Store info", account: "a-ig", shortcut: "/hours",
    variants: V("Our Palermo store is open Monday to Saturday 8:00–20:00 and Sundays 9:00–14:00.", "Nuestro local de Palermo abre de lunes a sábado de 8 a 20 y los domingos de 9 a 14."),
  },
  {
    id: "s-damaged", title: "Damaged order", category: "Apologies", account: null, shortcut: "/damaged",
    variants: V(
      "We're really sorry your order arrived damaged. We'll send a replacement at no cost — could you confirm your shipping address?",
      "Lamentamos mucho que tu pedido llegara dañado. Te enviamos un reemplazo sin costo — ¿nos confirmás la dirección de envío?",
    ),
  },
  {
    id: "s-grind", title: "Grind guide", category: "Products", account: null, shortcut: "/grind",
    variants: V(
      "For a moka pot we recommend a medium-fine grind; for French press, coarse; for espresso, fine. We can grind any coffee for you.",
      "Para cafetera moka recomendamos molienda media-fina; para prensa francesa, gruesa; para espresso, fina. Podemos moler cualquier café para vos.",
      "Para cafeteira italiana recomendamos moagem média-fina; para prensa francesa, grossa; para espresso, fina. Podemos moer qualquer café para você.",
    ),
  },
  {
    id: "s-roastery", title: "Roast date of the current batch", category: "Products", account: "a-ig2", shortcut: "/roast",
    variants: V("Our current Huila batch was roasted on Monday; we roast every week so it's always fresh.", "El lote actual de Huila se tostó el lunes; tostamos todas las semanas, así que siempre está fresco."),
  },
];

/** Predefined, illustrative draft translations (exact text only). Saved-reply variants count as translations of each other. */
const SAMPLE_PAIRS: readonly { readonly [L in Lang]?: string }[] = [
  {
    es: "¡Hola Nina! Nos encantaría hacer un video de degustación juntos. ¿Qué fechas tenés disponibles?",
    pt: "Oi, Nina! Adoraríamos fazer um vídeo de degustação juntos. Quais datas você tem disponíveis?",
    en: "Hi Nina! We'd love to make a tasting video together. Which dates are you available?",
  },
  {
    en: "Thank you for reaching out! Our wholesale team will send a quote for 40 kg per month today. Could you share a contact email?",
    es: "¡Gracias por escribirnos! Nuestro equipo mayorista les enviará hoy una cotización por 40 kg mensuales. ¿Nos comparten un email de contacto?",
  },
];

/** The predefined translation of `text` into `to`, if this prototype has one. */
export function translateDraft(text: string, to: Lang): { readonly text: string; readonly from: Lang } | null {
  const needle = text.trim();
  const families: { readonly [L in Lang]?: string }[] = [...SAMPLE_PAIRS, ...SAVED_REPLIES.map((r) => Object.fromEntries(r.variants.map((v) => [v.lang, v.text])) as { [L in Lang]?: string })];
  for (const family of families) {
    const from = (Object.keys(family) as Lang[]).find((lang) => family[lang] === needle);
    const target = family[to];
    if (from !== undefined && from !== to && target !== undefined) return { text: target, from };
  }
  return null;
}

/** Which language a known draft is in (for the "From" side of the translate panel); null when unknown. */
export function detectFixtureLang(text: string): Lang | null {
  const needle = text.trim();
  for (const family of [...SAMPLE_PAIRS, ...SAVED_REPLIES.map((r) => Object.fromEntries(r.variants.map((v) => [v.lang, v.text])) as { [L in Lang]?: string })]) {
    const from = (Object.keys(family) as Lang[]).find((lang) => family[lang] === needle);
    if (from !== undefined) return from;
  }
  return null;
}

export interface Emoji {
  readonly char: string;
  readonly name: string;
  readonly group: "Smileys" | "Gestures" | "Hearts" | "Food & drink" | "Objects" | "Symbols";
}

const E = (group: Emoji["group"], list: string): Emoji[] =>
  list.split(";").map((pair) => {
    const [char = "", name = ""] = pair.split("|");
    return { char, name, group };
  });

export const EMOJI: readonly Emoji[] = [
  ...E("Smileys", "😀|grinning face;😃|smiling face with big eyes;😄|grinning face with smiling eyes;😁|beaming face;😊|smiling face with smiling eyes;🙂|slightly smiling face;😉|winking face;😍|heart eyes;🥰|smiling face with hearts;😘|face blowing a kiss;😋|face savoring food;😎|smiling face with sunglasses;🤩|star struck;🥳|partying face;😅|grinning face with sweat;😂|tears of joy;🤗|hugging face;🤔|thinking face;😐|neutral face;😮|face with open mouth;😢|crying face;😔|pensive face;🙏|folded hands"),
  ...E("Gestures", "👍|thumbs up;👎|thumbs down;👏|clapping hands;🙌|raising hands;👋|waving hand;🤝|handshake;✌️|victory hand;👌|ok hand;👆|pointing up;👉|pointing right;💪|flexed biceps;🤞|crossed fingers"),
  ...E("Hearts", "❤️|red heart;🧡|orange heart;💛|yellow heart;💚|green heart;💙|blue heart;🤎|brown heart;🖤|black heart;🤍|white heart;💖|sparkling heart;💕|two hearts"),
  ...E("Food & drink", "☕|hot beverage coffee;🫘|beans;🥐|croissant;🍪|cookie;🍫|chocolate bar;🥛|glass of milk;🧁|cupcake;🍰|cake;🥤|cup with straw;🧋|bubble tea;🍵|teacup;🥖|baguette"),
  ...E("Objects", "📦|package;🚚|delivery truck;🧾|receipt;💳|credit card;📍|round pushpin location;🕒|three o'clock time;📅|calendar;🎁|gift;📸|camera with flash;✉️|envelope;📞|telephone;🛍️|shopping bags"),
  ...E("Symbols", "✅|check mark button;✔️|check mark;❗|exclamation mark;❓|question mark;⭐|star;✨|sparkles;🔥|fire;🎉|party popper;💯|hundred points;➡️|right arrow;🆕|new button;⚠️|warning"),
];

export const EMOJI_GROUPS: readonly Emoji["group"][] = ["Smileys", "Gestures", "Hearts", "Food & drink", "Objects", "Symbols"];

const SAMPLE_DRAFTS: Readonly<Record<string, Draft>> = {
  // Outgoing Spanish → Portuguese scenario: a draft written in Spanish for a Portuguese-speaking person.
  "c-nina": { mode: "reply", reply: "¡Hola Nina! Nos encantaría hacer un video de degustación juntos. ¿Qué fechas tenés disponibles?", original: null, translated: null, note: "" },
  "c-sol": { mode: "reply", reply: "Hi Sol! Let me check the roast date with the roastery.", original: null, translated: null, note: "" },
};

export function initialState(): State {
  return { conversations: CONVERSATIONS, drafts: SAMPLE_DRAFTS, savedReplies: SAVED_REPLIES, toast: null, showFuture: false, scenario: "normal", sendMode: "contextual", seq: 0 };
}
