/**
 * Comments prototype fixtures (Step 7B-15N) — DEVELOPMENT ONLY, synthetic data. One fictional workspace ("Lumen
 * Coffee"), two fictional connected accounts and a handful of conversations shaped to exercise every state the Comments
 * experience must draw: an unanswered complaint, replies Sending / Sent / Checking / Failed / Blocked, a hidden comment,
 * a comment gone from the platform, markup-like and very long text, an unread anchor, and a conversation whose post
 * context is unknown. Nothing here is real, read from a database or sent anywhere.
 *
 * `demo` is a DEMONSTRATION of how future understanding (label, "why it's here", suggested reply) would sit in the
 * layout. Wrenkind produces none of it today; the page draws it only behind the explicit `?intel=demo` switch and
 * marks every instance as demo data.
 */

export type Platform = "instagram" | "facebook";
export type Source = "organic" | "paid" | "mixed" | "unknown";
export type OutboundState = "sending" | "sent" | "checking" | "failed" | "blocked";

export interface Account {
  readonly id: string;
  readonly platform: Platform;
  /** The account as the person knows it: an @handle on Instagram, a Page name on Facebook. */
  readonly label: string;
}

export interface Post {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "Post" | "Reel" | "Ad";
  readonly source: Source;
  /** A short name for the post (its first words); null when Wrenkind has not read the post. */
  readonly title: string | null;
  readonly caption: string | null;
  readonly publishedAt: string | null;
}

export interface Message {
  readonly id: string;
  readonly parentId: string | null;
  readonly author: { readonly kind: "audience" | "own" | "unknown"; readonly name: string | null };
  /** null: the message's place in the conversation is known but its text was not read. */
  readonly text: string | null;
  readonly at: string | null;
  readonly presence: "present" | "hidden" | "removed";
  readonly editedAt?: string;
}

export interface Outbound {
  readonly id: string;
  readonly parentId: string;
  readonly text: string;
  readonly state: OutboundState;
  readonly requestedAt: string;
  readonly confirmedAt: string | null;
}

export interface DemoUnderstanding {
  /** One primary label (IA §7.5-A), a square data box. */
  readonly label: string;
  /** "Why it's here", short form for the row (IA §7.6). */
  readonly reason: string;
  /** The full factor list for the expanded conversation. */
  readonly factors: readonly string[];
  readonly needsReview?: boolean;
  /** A suggested starting point (IA §8.2) — never sent, never pre-filled into the composer. */
  readonly suggestion?: { readonly text: string; readonly basedOn: string; readonly missing?: string };
}

export interface Conversation {
  readonly id: string;
  readonly postId: string | null;
  readonly status: "open" | "done";
  readonly latestAt: string;
  readonly messages: readonly Message[];
  readonly outbound: readonly Outbound[];
  readonly notYetRead?: number;
  readonly demo?: DemoUnderstanding;
}

export const WORKSPACE = { name: "Lumen Coffee", organization: "Lumen Group" } as const;
export const AS_OF = "2026-11-08T23:28:00Z";

export const ACCOUNTS: readonly Account[] = [
  { id: "acc-ig", platform: "instagram", label: "@lumen.coffee" },
  { id: "acc-fb", platform: "facebook", label: "Lumen Coffee" },
];

export const POSTS: readonly Post[] = [
  { id: "p-coldbrew", accountId: "acc-ig", kind: "Ad", source: "paid", title: "Cold brew launch", caption: "Nuevo cold brew de temporada ☕️ Pedilo online con envío a todo el país. Stock limitado.", publishedAt: "2026-11-01T14:00:00Z" },
  { id: "p-hours", accountId: "acc-fb", kind: "Post", source: "organic", title: "Holiday opening hours", caption: "Horarios especiales para el fin de semana largo. Abrimos sábado y domingo de 9 a 18.", publishedAt: "2026-11-06T10:30:00Z" },
  { id: "p-roast", accountId: "acc-ig", kind: "Reel", source: "mixed", title: "Behind the roast", caption: "Cómo tostamos cada lote, de la bolsa verde a tu taza. 🎥", publishedAt: "2026-11-04T18:00:00Z" },
  { id: "p-unknown", accountId: "acc-ig", kind: "Post", source: "unknown", title: null, caption: null, publishedAt: null },
];

const caro = { kind: "audience", name: "caro.m" } as const;
const own = { kind: "own", name: null } as const;

export const CONVERSATIONS: readonly Conversation[] = [
  {
    id: "c1",
    postId: "p-coldbrew",
    status: "open",
    latestAt: "2026-11-08T23:14:00Z",
    messages: [
      { id: "m1", parentId: null, author: caro, text: "Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder? Ya escribí dos veces por privado y nadie contesta.", at: "2026-11-08T22:50:00Z", presence: "present", editedAt: "2026-11-08T22:58:00Z" },
      { id: "m2", parentId: "m1", author: { kind: "audience", name: "Marta P." }, text: "Me pasó lo mismo la semana pasada 😕", at: "2026-11-08T23:14:00Z", presence: "present" },
    ],
    outbound: [],
    demo: {
      label: "Delivery complaint",
      reason: "Complaint on an active ad · waiting 38 min",
      factors: ["Complaint about a late order", "On an active ad (Cold brew launch)", "Waiting 38 min, within business hours", "A second person reports the same problem"],
      suggestion: { text: "Hola Caro, lamentamos mucho la demora. ¿Nos pasás tu número de pedido por mensaje privado? Lo revisamos hoy mismo.", basedOn: "Shipping policy · Contact channels", missing: "No delivery-time information in Brand Context" },
    },
  },
  {
    id: "c2",
    postId: "p-hours",
    status: "open",
    latestAt: "2026-11-08T23:20:00Z",
    messages: [{ id: "m10", parentId: null, author: { kind: "audience", name: "Marta P." }, text: "¿Abren el domingo por la mañana? Quiero pasar con mi familia.", at: "2026-11-08T21:02:00Z", presence: "present" }],
    outbound: [{ id: "o10", parentId: "m10", text: "¡Hola Marta! Sí, el domingo abrimos de 9 a 18. ¡Los esperamos!", state: "sending", requestedAt: "2026-11-08T23:20:00Z", confirmedAt: null }],
    demo: { label: "Question", reason: "Opening-hours question · reply on its way", factors: ["Question about opening hours", "Organic post", "A reply was requested 8 min ago"] },
  },
  {
    id: "c3",
    postId: "p-roast",
    status: "open",
    latestAt: "2026-11-08T23:22:00Z",
    messages: [
      { id: "m20", parentId: null, author: { kind: "audience", name: "lucas_mz" }, text: "O preço subiu de novo? Achei caro demais para o que entrega. <b>não</b> recomendo https://example.test/promo/cold-brew-temporada-2026-oferta-especial-limitada?utm_source=instagram&utm_medium=social", at: "2026-11-08T19:40:00Z", presence: "present" },
      { id: "m21", parentId: "m20", author: { kind: "audience", name: "ana.lu" }, text: "Concordo, tá caro.", at: "2026-11-08T20:05:00Z", presence: "hidden" },
    ],
    outbound: [{ id: "o20", parentId: "m20", text: "Oi Lucas! O preço mudou por causa do novo grão, mas temos opções a partir de R$ 18.", state: "checking", requestedAt: "2026-11-08T23:22:00Z", confirmedAt: null }],
    demo: { label: "Price objection", reason: "Commercial objection · reply being checked", factors: ["Price objection (commercial)", "Protected: complaints and objections are never hidden automatically", "Portuguese — differs from the workspace language"] },
  },
  {
    id: "c4",
    postId: "p-coldbrew",
    status: "open",
    latestAt: "2026-11-08T23:21:30Z",
    messages: [{ id: "m30", parentId: null, author: { kind: "audience", name: "joao.p" }, text: "Amei! Onde compro? 😍", at: "2026-11-08T22:40:00Z", presence: "present" }],
    outbound: [{ id: "o30", parentId: "m30", text: "¡Gracias João! Lo encontrás en lumen.coffee/coldbrew 🙌", state: "sent", requestedAt: "2026-11-08T23:21:00Z", confirmedAt: "2026-11-08T23:21:30Z" }],
    demo: { label: "Purchase question", reason: "Purchase question on an active ad · answered", factors: ["Purchase intent", "On an active ad", "Your reply was published"] },
  },
  {
    id: "c5",
    postId: "p-hours",
    status: "open",
    latestAt: "2026-11-08T23:23:00Z",
    messages: [{ id: "m40", parentId: null, author: { kind: "audience", name: "Sofi R." }, text: "El sábado estaba cerrado a las 10, decía abierto 😤", at: "2026-11-08T22:30:00Z", presence: "removed" }],
    outbound: [{ id: "o40", parentId: "m40", text: "Lo sentimos Sofi, ¿nos contás qué sucursal era?", state: "failed", requestedAt: "2026-11-08T23:23:00Z", confirmedAt: null }],
    demo: { label: "Complaint", reason: "Complaint · removed by its author", factors: ["Complaint about opening hours", "The comment is no longer on Facebook"] },
  },
  {
    id: "c6",
    postId: "p-coldbrew",
    status: "open",
    latestAt: "2026-11-08T22:05:00Z",
    messages: [
      {
        id: "m50",
        parentId: null,
        author: { kind: "audience", name: "Valentina Inés Rodríguez Echeverría" },
        text: "Les escribo porque es la tercera vez que compro y siempre pasa algo distinto. La primera vez el paquete llegó abierto, la segunda vez llegó otro sabor y ahora directamente no llegó nada y el seguimiento dice entregado. Me encanta el café, de verdad, pero así no se puede. Quiero saber si alguien lo está mirando o si tengo que pedir el reembolso por el banco.\n\nDejo el número por si sirve: LUM-2026-110482.",
        at: "2026-11-08T22:05:00Z",
        presence: "present",
      },
    ],
    outbound: [{ id: "o50", parentId: "m50", text: "Hola Valentina, lo revisamos ya mismo.", state: "blocked", requestedAt: "2026-11-08T22:10:00Z", confirmedAt: null }],
    demo: { label: "Refund risk", reason: "Complaint with refund intent · waiting 1 h 23 min", factors: ["Repeated delivery problems", "Mentions a bank chargeback (reputation and revenue risk)", "Contains an order number"], suggestion: { text: "Hola Valentina, lamentamos muchísimo lo que pasó. Ya tenemos tu número de pedido: te escribimos por privado en la próxima hora con una solución.", basedOn: "Refund policy · Contact channels" } },
  },
  {
    id: "c7",
    postId: "p-roast",
    status: "open",
    latestAt: "2026-11-08T21:50:00Z",
    messages: [{ id: "m60", parentId: null, author: { kind: "audience", name: "promo.cafe.gratis" }, text: "GANÁ CAFÉ GRATIS 👉 entrá al link de mi perfil 🔥🔥🔥", at: "2026-11-08T21:50:00Z", presence: "present" }],
    outbound: [],
    demo: { label: "Possible spam", reason: "Needs a human look: possible spam link", factors: ["Promotional text pointing to a profile link", "Not hidden automatically: automation is off in this workspace"], needsReview: true },
  },
  {
    id: "c8",
    postId: "p-unknown",
    status: "open",
    latestAt: "2026-11-08T20:30:00Z",
    messages: [{ id: "m70", parentId: null, author: { kind: "unknown", name: null }, text: null, at: null, presence: "present" }],
    outbound: [],
    notYetRead: 2,
  },
  {
    id: "c9",
    postId: "p-hours",
    status: "done",
    latestAt: "2026-11-07T15:00:00Z",
    messages: [
      { id: "m80", parentId: null, author: { kind: "audience", name: "Bruno K." }, text: "¿Tienen opciones sin lactosa?", at: "2026-11-07T14:10:00Z", presence: "present" },
      { id: "m81", parentId: "m80", author: own, text: "¡Hola Bruno! Sí: leche de avena y de almendras en todas las sucursales.", at: "2026-11-07T15:00:00Z", presence: "present" },
    ],
    outbound: [],
  },
];
