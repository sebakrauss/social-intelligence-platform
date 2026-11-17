/**
 * Comments experience redesign (Step 7B-17V) — DEVELOPMENT ONLY, synthetic data. One fictional workspace with four
 * fictional connected accounts (two Facebook Pages, two Instagram accounts) and 36 conversations written to exercise
 * what the redesigned Comments page must draw: short and long comments in English, Spanish and Portuguese, replies to
 * replies, a long thread, replies the brand published earlier (from Wrenkind and directly on the platform), hidden and
 * removed comments, unknown post details and organic/paid source, several manual labels per comment, and one account
 * whose verified name is not available. Step 7B-17V-UX adds what the comment actions need to be drawn honestly: posts
 * whose comments a platform does not let other apps manage (an Instagram live video and story ad, a post another
 * account owns), ads whose moderation is not validated, a connection that needs attention, comments past the private
 * reply window, and synthetic examples of automatic assessments. Nothing here is real, read from a database or sent
 * anywhere.
 */

export type Platform = "facebook" | "instagram";
/** Reported organic/paid source of the post (PD D-38). "unknown" is never inferred into organic or paid. */
export type Source = "organic" | "paid" | "mixed" | "unknown";

export interface Account {
  readonly id: string;
  readonly platform: Platform;
  /**
   * The provider's own name for the connected asset (connections.discovered_assets.display_name: a Page name on
   * Facebook, the @username on Instagram). Null: the name is not available, and the page never invents one.
   */
  readonly verifiedName: string | null;
  /** Read coverage of this account's comments (a summary of the coverage record). */
  readonly coverage: "complete" | "partial";
  /** Connection health (a prototype control can make every connection healthy). */
  readonly health: "healthy" | "needs_attention";
}

export interface Post {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "Post" | "Reel" | "Video" | "Ad" | "Live video" | "Story ad";
  readonly source: Source;
  /** The first words of the post; null when Wrenkind has not read the post itself. */
  readonly caption: string | null;
  /**
   * Where the comments live, as far as comment actions are concerned: an ordinary post, a live video or a story ad
   * (Instagram does not let other apps manage those comments), or a Facebook ad that never ran as a Page post (a
   * "dark post": moderating its comments is not validated).
   */
  readonly surface: "feed" | "live" | "story_ad" | "dark_post";
  /** Null: the connected account posted it. Otherwise the account that did (the connected account is only tagged). */
  readonly owner: string | null;
}

export type Author = { readonly kind: "audience"; readonly name: string } | { readonly kind: "own" } | { readonly kind: "unknown" };

/**
 * A SYNTHETIC example of an automatic assessment (Wrenkind's understanding of a comment). Shown only when the prototype
 * control asks for examples: no assessment is produced today, by AI or otherwise. `protected` marks the meanings that
 * are never hidden automatically (complaints, accusations against the brand, commercial objections — S2, S3).
 */
export interface Assessment {
  readonly meaning: "Complaint" | "Question" | "Spam" | "Praise" | "Accusation against the brand" | "Commercial objection";
  readonly protected: boolean;
}

export interface Comment {
  readonly id: string;
  readonly parentId: string | null;
  readonly author: Author;
  readonly text: string;
  /** When it was written on the platform. */
  readonly at: string;
  readonly editedAt: string | null;
  /** When Wrenkind read this text. */
  readonly readAt: string;
  readonly presence: "present" | "hidden" | "removed";
}

/** A reply published earlier through Wrenkind: the record of a person's request, confirmed by the platform. */
export interface SentReply {
  readonly id: string;
  readonly parentId: string;
  readonly text: string;
  readonly requestedAt: string;
  readonly publishedAt: string;
  /** The workspace member who pressed Publish (planned data: member names are not in today's read model). */
  readonly requestedBy: string;
}

export interface Conversation {
  readonly id: string;
  readonly postId: string | null;
  readonly accountId: string;
  readonly comments: readonly Comment[];
  readonly sent: readonly SentReply[];
}

export interface Label {
  readonly id: string;
  readonly name: string;
}

export const WORKSPACE = { name: "Lumen Coffee", organization: "Lumen Group" } as const;
/** The synthetic "now" every fixture time is measured from. */
export const AS_OF = "2026-11-17T15:00:00Z";

export const ACCOUNTS: readonly Account[] = [
  { id: "acc-fb-main", platform: "facebook", verifiedName: "Lumen Coffee", coverage: "complete", health: "healthy" },
  { id: "acc-ig-main", platform: "instagram", verifiedName: "@lumen.coffee", coverage: "complete", health: "healthy" },
  // A connection that needs attention: actions on its comments are blocked with a recovery, never called unsupported.
  { id: "acc-fb-events", platform: "facebook", verifiedName: "Lumen Coffee Eventos", coverage: "partial", health: "needs_attention" },
  // A connected account whose name Wrenkind does not have: the page must fall back to a neutral description.
  { id: "acc-ig-roastery", platform: "instagram", verifiedName: null, coverage: "complete", health: "healthy" },
];

export const POSTS: readonly Post[] = [
  { id: "post-1", accountId: "acc-ig-main", kind: "Reel", source: "organic", caption: "The holiday blend is back — notes of cherry, cacao and orange peel.", surface: "feed", owner: null },
  { id: "post-2", accountId: "acc-ig-main", kind: "Ad", source: "paid", caption: "Your first subscription box ships free.", surface: "feed", owner: null },
  { id: "post-3", accountId: "acc-fb-main", kind: "Post", source: "organic", caption: "We're opening our third café in Palermo on Saturday.", surface: "feed", owner: null },
  { id: "post-4", accountId: "acc-fb-main", kind: "Video", source: "mixed", caption: "How we roast: a five-minute visit to the roastery.", surface: "feed", owner: null },
  { id: "post-5", accountId: "acc-fb-events", kind: "Post", source: "unknown", caption: "Latte art workshop — limited places, sign up below.", surface: "feed", owner: null },
  { id: "post-6", accountId: "acc-ig-roastery", kind: "Post", source: "organic", caption: "New single origin: Huila, Colombia. Washed, bright, honeyed.", surface: "feed", owner: null },
  { id: "post-7", accountId: "acc-ig-main", kind: "Post", source: "unknown", caption: null, surface: "feed", owner: null },
  { id: "post-8", accountId: "acc-fb-main", kind: "Ad", source: "paid", caption: "Holiday gift boxes: order by 15 December for delivery before Christmas.", surface: "dark_post", owner: null },
  { id: "post-9", accountId: "acc-ig-main", kind: "Post", source: "organic", caption: "Free shipping on every subscription this week.", surface: "feed", owner: null },
  { id: "post-10", accountId: "acc-ig-main", kind: "Live video", source: "organic", caption: "Live from the roastery: cupping the holiday blend.", surface: "live", owner: null },
  { id: "post-11", accountId: "acc-ig-main", kind: "Story ad", source: "paid", caption: "Gift cards: the easiest present this season.", surface: "story_ad", owner: null },
  { id: "post-12", accountId: "acc-ig-main", kind: "Post", source: "unknown", caption: "Sunday brunch at home with @lumen.coffee beans.", surface: "feed", owner: "@brunch.club.ba" },
];

export const SEED_LABELS: readonly Label[] = [
  { id: "lbl-delivery", name: "Delivery" },
  { id: "lbl-refund", name: "Refund request" },
  { id: "lbl-praise", name: "Praise" },
  { id: "lbl-wholesale", name: "Wholesale lead" },
  { id: "lbl-follow", name: "Follow up Monday" },
  { id: "lbl-allergen", name: "Allergens" },
];

/* ───────────── compact authoring of the conversations ───────────── */

/** One message: author ("@" = the connected account; "?" = unknown author), text, index of its parent (default 0). */
type M = readonly [author: string, text: string, parent?: number, flags?: "hidden" | "removed" | "edited"];
interface Seed {
  readonly post: string | null;
  readonly account: string;
  readonly m: readonly M[];
  /** Replies published through Wrenkind: [parent index, text, member]. */
  readonly sent?: readonly (readonly [number, string, string])[];
  /** Manual labels already on comments: [message index, label id]. */
  readonly labels?: readonly (readonly [number, string])[];
  /** Synthetic assessments: [message index, meaning, protected]. */
  readonly assessed?: readonly (readonly [number, Assessment["meaning"], boolean])[];
  /** Days to push the whole conversation back in time (the private-reply window is seven days). */
  readonly daysAgo?: number;
}

const SEEDS: readonly Seed[] = [
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [
      ["caro.mendez", "Ordered on 2 Nov with the free shipping offer and it still hasn't arrived. The tracking link says 'label created' for ten days now. Can someone actually look at this?"],
      ["@", "Hi Caro, we're sorry — could you send us your order number by DM so we can check with the courier?"],
      ["caro.mendez", "It's #A-20931. I already wrote to support twice.", 1],
    ],
    labels: [[0, "lbl-delivery"], [0, "lbl-follow"]],
    assessed: [[0, "Complaint", true]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["joaquin.rv", "This blend is unreal. Best thing you've released this year ☕️🔥"]],
    sent: [[0, "Thank you, Joaquín! It goes fast — the roastery is already on batch four.", "Ana Ruiz"]],
    labels: [[0, "lbl-praise"]],
    assessed: [[0, "Praise", false]],
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [
      ["Martina Gómez", "¿Van a tener opciones sin lactosa en el nuevo local? Mi hija es intolerante y siempre tenemos que preguntar."],
      ["Lucía Fernández", "En el de Belgrano tienen leche de avena y de almendras, supongo que acá también.", 0],
      ["Martina Gómez", "Gracias Lucía! Igual me gustaría que lo confirme la marca.", 1],
    ],
    labels: [[0, "lbl-allergen"]],
    assessed: [[0, "Question", false]],
  },
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [["pedro.salles", "Cobraram o frete mesmo com a promoção. Quero o reembolso da diferença, por favor."]],
    labels: [[0, "lbl-refund"]],
    assessed: [[0, "Complaint", true]],
  },
  {
    post: "post-4",
    account: "acc-fb-main",
    m: [
      ["Diego Herrera", "Do you sell green beans wholesale? We run two cafés in Montevideo and are looking for a new supplier for 2027."],
      ["@", "Hi Diego! Yes — our wholesale team will be glad to help. Could you share your weekly volume?"],
      ["Diego Herrera", "Around 40 kg a week between both places, mostly espresso.", 1],
    ],
    labels: [[0, "lbl-wholesale"], [2, "lbl-wholesale"]],
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [["Sofía Quiroga", "¿Quedan lugares para el sábado? El formulario no me deja anotarme."]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["nina.coffeelab", "Is the holiday blend available in whole bean or only ground?"]],
    sent: [[0, "Both! Whole bean in 250 g and 1 kg, ground in 250 g.", "Ana Ruiz"]],
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [
      ["tomas.brews", "What's the recommended ratio for V60 with this one?"],
      ["@", "We like 1:16 with water at 93 °C. Let us know how it goes!"],
    ],
  },
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [["deals4u_official", "🔥 GET 90% OFF ALL COFFEE 🔥 visit our link in bio NOW", 0, "hidden"]],
    assessed: [[0, "Spam", false]],
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [
      ["Ramiro Paz", "El último pedido llegó con el paquete roto y la mitad del café desparramado en la caja. Pagué envío express para esto.", 0, "edited"],
      ["@", "Ramiro, lamentamos mucho lo ocurrido. Ya te escribimos por privado para reponer el pedido."],
    ],
    sent: [[0, "Ramiro, ya generamos la reposición sin costo. Te llega el lunes.", "Bruno Díaz"]],
    labels: [[0, "lbl-delivery"], [0, "lbl-refund"]],
    assessed: [[0, "Complaint", true]],
  },
  {
    post: "post-7",
    account: "acc-ig-main",
    m: [["?", "Where can I buy this in Lima?"]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [
      ["valen.cafe", "Mine tastes really sour this time, did something change in the roast?"],
      ["camila.r", "Try a finer grind, mine was sour until I changed it.", 0],
      ["valen.cafe", "Will try, thanks!", 1],
      ["@", "Thanks Camila! Valen, a finer grind and 2–3 °C hotter water usually fixes it. Tell us if it doesn't."],
    ],
  },
  {
    post: "post-4",
    account: "acc-fb-main",
    m: [["Hernán Ortiz", "Video increíble. ¿Se puede visitar el tostadero?"]],
  },
  {
    post: "post-2",
    account: "acc-ig-main",
    m: [["luiza.mota", "Assinei semana passada e ainda não recebi o e-mail de confirmação 🤔"]],
    labels: [[0, "lbl-follow"]],
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [
      ["Paula Ibarra", "Fui al taller del mes pasado y fue lo mejor. 100% recomendado ❤️"],
      ["Sofía Quiroga", "¡Qué bueno! Me anoto para este.", 0],
    ],
    labels: [[0, "lbl-praise"]],
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [["andres.v", "Bought two bags and one was clearly stale. Not what I expect at this price.", 0, "removed"]],
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [["Gabriela Núñez", "¡Por fin en Palermo! ¿Abren los domingos?"]],
    sent: [[0, "¡Sí, Gabriela! Domingos de 9 a 19.", "Ana Ruiz"]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["mateo.lopez", "Does the holiday blend contain any nuts or flavourings? My partner has a nut allergy."]],
    labels: [[0, "lbl-allergen"]],
  },
  // The long thread: eleven people and the brand around one shipping complaint.
  {
    post: "post-2",
    account: "acc-ig-main",
    m: [
      ["renata.soto", "Third week waiting for my subscription box. Anyone else? 😤"],
      ["fran.gil", "Same here, mine is stuck in Córdoba.", 0],
      ["luiza.mota", "Mine too!! And no answer to emails", 0],
      ["@", "We're really sorry everyone. A courier hub had a backlog — boxes are moving again since this morning."],
      ["renata.soto", "Moving where? Tracking shows nothing new.", 3],
      ["marcos.b", "Honestly I'm cancelling if it's not here by Friday.", 0],
      ["@", "Renata, could you DM us your order number? We'll check it personally.", 4],
      ["renata.soto", "Sent.", 6],
      ["fran.gil", "Update: mine just changed to 'in transit'.", 1],
      ["ines.ac", "Not mine. Ordered on the 1st.", 0],
      ["@", "Inés, thank you for your patience — we've added a free bag to every delayed order."],
      ["ines.ac", "That's nice, thanks. Still want the box though 😅", 10],
      ["pato.r", "Got mine today, all fine!", 0],
      ["renata.soto", "Mine arrived. Thanks for following up.", 6],
    ],
    sent: [[4, "Renata, we've escalated your order with the courier — you should see an update by tonight.", "Bruno Díaz"]],
    labels: [[0, "lbl-delivery"], [5, "lbl-delivery"], [5, "lbl-refund"], [9, "lbl-delivery"]],
    assessed: [[0, "Complaint", true], [5, "Commercial objection", true]],
  },
  {
    post: "post-4",
    account: "acc-fb-main",
    m: [["Julián Benítez", "¿Cuál es la diferencia entre el tueste medio y el oscuro en sabor?"]],
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [["coffee.nerd.ba", "Huila washed is one of my favourites. What's the altitude for this lot?"]],
    sent: [[0, "1,750–1,900 m, from three farms around Pitalito.", "Bruno Díaz"]],
  },
  {
    post: null,
    account: "acc-fb-main",
    m: [["Claudia Ríos", "Hola, ¿hacen facturas para empresa? Queremos pedir café para la oficina todos los meses."]],
    labels: [[0, "lbl-wholesale"]],
  },
  {
    post: "post-11",
    account: "acc-ig-main",
    m: [["bia.carvalho", "Qual é o prazo de entrega para Porto Alegre?"]],
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [["Esteban Molina", "Precio del taller? No lo encuentro en el post."]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["lu.barista", "Pulled this as espresso this morning, 18 g in, 38 g out, 29 s. Chocolate bomb. Thank you for this one!"]],
    labels: [[0, "lbl-praise"]],
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [
      ["Federico Luna", "La última vez me cobraron dos veces el mismo pedido en la tienda online. ¿A quién le escribo para que me devuelvan el cargo duplicado?"],
      ["@", "Federico, escribinos a ayuda@ con el comprobante y lo resolvemos hoy mismo."],
      ["Federico Luna", "Ya escribí ayer y no tuve respuesta.", 1],
    ],
    labels: [[0, "lbl-refund"], [2, "lbl-follow"]],
    assessed: [[0, "Complaint", true]],
  },
  {
    post: "post-10",
    account: "acc-ig-main",
    m: [["mica.ph", "Love the new packaging design!"]],
  },
  {
    post: "post-8",
    account: "acc-fb-main",
    m: [["Ana Laura Vega", "Esto es publicidad engañosa, la caja que me llegó no tiene nada que ver con la del anuncio."]],
    assessed: [[0, "Accusation against the brand", true]],
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [
      ["sergio.cafe", "Will this be available in the subscription?"],
      ["@", "Yes — it's the December pick for the Explorer plan."],
      ["sergio.cafe", "Then I'm upgrading 🙌", 1],
    ],
  },
  {
    post: "post-2",
    account: "acc-ig-main",
    m: [["gus.martins", "Vocês entregam no Uruguai?"]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["?", "Is this the same as last year's holiday blend or a new recipe?"]],
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [["Silvia Acosta", "¿Tienen accesibilidad para silla de ruedas en el nuevo local?"]],
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [["Nicolás Ferreyra", "Hacen talleres para empresas? Somos un equipo de 15."]],
    labels: [[0, "lbl-wholesale"]],
  },
  {
    post: "post-2",
    account: "acc-ig-main",
    m: [["clara.ok", "Cancelled my subscription and was still charged this month. Please refund."]],
    labels: [[0, "lbl-refund"]],
    assessed: [[0, "Complaint", true]],
    // Five days older: the private-reply window closes in less than a day.
    daysAgo: 5,
  },
  {
    // A post another account published and tagged the brand in: its owner, not the brand, manages its comments.
    post: "post-12",
    account: "acc-ig-main",
    m: [["roberto.a", "Too expensive for what it is honestly"]],
    assessed: [[0, "Commercial objection", true]],
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [["ju.lima", "Arrived beautifully packed, thank you!"]],
    // Older than seven days: no private reply is possible any more.
    daysAgo: 9,
  },
];

/* ───────────── expansion into dated records ───────────── */

const minutes = (iso: string, delta: number): string => new Date(new Date(iso).getTime() + delta * 60_000).toISOString().replace(".000Z", "Z");
const pad = (value: number): string => String(value).padStart(2, "0");

function authorOf(code: string): Author {
  if (code === "@") return { kind: "own" };
  if (code === "?") return { kind: "unknown" };
  return { kind: "audience", name: code };
}

/**
 * The conversations, newest activity first: conversation i's last message is about 47 minutes older than conversation
 * i−1's, and the messages inside one conversation are 9–23 minutes apart (deterministic; no clock is read).
 */
export const CONVERSATIONS: readonly Conversation[] = SEEDS.map((seed, index) => {
  const id = `cv-${pad(index + 1)}`;
  const last = minutes(AS_OF, -(12 + index * 47) - (seed.daysAgo ?? 0) * 1440);
  const count = seed.m.length + (seed.sent?.length ?? 0);
  const start = minutes(last, -count * 16);
  const comments = seed.m.map(([code, text, parent, flag], position): Comment => {
    const at = minutes(start, position * 16 + (position % 3) * 7);
    return {
      id: `${id}-m${pad(position)}`,
      parentId: position === 0 ? null : `${id}-m${pad(parent ?? 0)}`,
      author: authorOf(code),
      text,
      at,
      editedAt: flag === "edited" ? minutes(at, 11) : null,
      readAt: minutes(at, 2),
      presence: flag === "hidden" ? "hidden" : flag === "removed" ? "removed" : "present",
    };
  });
  const sent = (seed.sent ?? []).map(([parent, text, member], position): SentReply => {
    const parentAt = comments[parent]?.at ?? start;
    const requestedAt = minutes(parentAt, 6 + position * 3);
    return { id: `${id}-s${pad(position)}`, parentId: `${id}-m${pad(parent)}`, text, requestedAt, publishedAt: minutes(requestedAt, 1), requestedBy: member };
  });
  return { id, postId: seed.post, accountId: seed.account, comments, sent };
});

/** The labels already on comments when the prototype starts: comment id → label ids. */
export const SEED_ASSIGNMENTS: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  SEEDS.forEach((seed, index) => {
    for (const [position, label] of seed.labels ?? []) {
      const key = `cv-${pad(index + 1)}-m${pad(position)}`;
      (out[key] ??= []).push(label);
    }
  });
  return out;
})();

/** The synthetic assessments (shown only when the prototype control asks for examples): comment id → assessment. */
export const SEED_ASSESSMENTS: Readonly<Record<string, Assessment>> = (() => {
  const out: Record<string, Assessment> = {};
  SEEDS.forEach((seed, index) => {
    for (const [position, meaning, isProtected] of seed.assessed ?? []) out[`cv-${pad(index + 1)}-m${pad(position)}`] = { meaning, protected: isProtected };
  });
  return out;
})();
