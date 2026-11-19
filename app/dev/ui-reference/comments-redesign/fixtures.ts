/**
 * Comments experience redesign (Step 7B-17V) — DEVELOPMENT ONLY, synthetic data. One fictional workspace with four
 * fictional connected accounts (two Facebook Pages, two Instagram accounts) and 36 conversations written to exercise
 * what the redesigned Comments page must draw: short and long comments in English, Spanish and Portuguese, replies to
 * replies, a long thread, replies the brand published earlier (from Wrenkind and directly on the platform), hidden and
 * removed comments, unknown post details and organic/paid source, several manual labels on one conversation, and one account
 * whose verified name is not available. Step 7B-17V-UX adds what the comment actions need to be drawn honestly: posts
 * whose comments a platform does not let other apps manage (an Instagram live video and story ad, a post another
 * account owns), ads whose moderation is not validated, a connection that needs attention, comments past the private
 * reply window, and synthetic examples of automatic assessments. Step UX-04 adds a fictional team (assignees), the
 * conversations' seeded workflow (Open / Done, assignee, a person's Urgent flag, an escalation, their history), twelve
 * newer conversations inside the response target, and a reply whose outcome is still being checked. UX-08A adds six
 * conversations dated in earlier months (cv-49…cv-54) for the date periods: an old one still open, one received last
 * month with activity this month, two on the same post with different labels, one resolved last month, and a month and
 * a year boundary that fall on different days in UTC and in the workspace's time zone. Nothing here is real, read from
 * a database or sent anywhere.
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

/**
 * A label's marker color: an identifier of the approved label palette (Manual v1.1 Amendment 2, PO-approved
 * 2026-11-18), never a color value — the stylesheet draws each through its theme token (--wk-label-*). Gray is the
 * default. Brown was proposed in UX-03 and rejected; it does not exist.
 */
export type Marker = "gray" | "teal" | "plum" | "magenta" | "olive";

export interface Label {
  readonly id: string;
  readonly name: string;
  /** The workspace label's color (a palette identifier). Absent: gray, the default. */
  readonly marker?: Marker;
}

/** The fictional team of the workspace. The person using the prototype is Ana Ruiz, whatever role is chosen. */
export interface Member {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly team: "Support" | "Sales" | "Management";
}

export const MEMBERS: readonly Member[] = [
  { id: "m-ana", name: "Ana Ruiz", initials: "AR", team: "Management" },
  { id: "m-bruno", name: "Bruno Díaz", initials: "BD", team: "Support" },
  { id: "m-carla", name: "Carla Méndez", initials: "CM", team: "Sales" },
  { id: "m-tomas", name: "Tomás Lerner", initials: "TL", team: "Sales" },
  // A long name on purpose (UX-05): menus and the assignee control are checked against it.
  { id: "m-maximiliana", name: "Maximiliana Fernández-Etcheverry", initials: "MF", team: "Support" },
];
export const ME = "m-ana";
/** Where a conversation can be escalated to (a person or team outside the first answer). */
export const ESCALATION_TARGETS: readonly string[] = ["Support lead", "Finance", "Product", "Legal", "Customer experience and quality team"];

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

/** The workspace's labels. Four carry a color someone chose in Settings; two keep the gray default. */
export const SEED_LABELS: readonly Label[] = [
  { id: "lbl-delivery", name: "Delivery" },
  { id: "lbl-refund", name: "Refund request", marker: "magenta" },
  { id: "lbl-praise", name: "Praise", marker: "plum" },
  { id: "lbl-wholesale", name: "Wholesale lead", marker: "teal" },
  { id: "lbl-follow", name: "Follow up Monday" },
  { id: "lbl-allergen", name: "Allergens", marker: "olive" },
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
  /**
   * Manual labels already on the conversation (UX-07B: a label belongs to the conversation — the root comment and its
   * replies — never to one reply, and never to every conversation on the same post).
   */
  readonly labels?: readonly string[];
  /** Synthetic assessments: [message index, meaning, protected]. */
  readonly assessed?: readonly (readonly [number, Assessment["meaning"], boolean])[];
  /** Days to push the whole conversation back in time (the private-reply window is seven days). */
  readonly daysAgo?: number;
  /** Minutes before "now" of the last message, instead of the position-based spacing (UX-04 scenarios). */
  readonly minutesAgo?: number;
  /**
   * UX-08A: the exact moment each message was written (one per message, in order), for the conversations that test
   * periods — an older month, a month or year that ends at a different moment in the workspace's time zone.
   */
  readonly times?: readonly string[];
  /** Seeded workflow (UX-04): assignee member id, Done with a resolution, a person's Urgent flag, an escalation. */
  readonly flow?: { readonly assignee?: string; readonly done?: SeedResolution; readonly urgent?: true; readonly escalated?: string };
}

/** The resolutions a seeded Done conversation can carry (the model owns their wording). */
export type SeedResolution = "replied_publicly" | "replied_privately" | "replied_on_platform" | "no_reply_needed" | "moderated";

const SEEDS: readonly Seed[] = [
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [
      ["caro.mendez", "Ordered on 2 Nov with the free shipping offer and it still hasn't arrived. The tracking link says 'label created' for ten days now. Can someone actually look at this?"],
      ["@", "Hi Caro, we're sorry — could you send us your order number by DM so we can check with the courier?"],
      ["caro.mendez", "It's #A-20931. I already wrote to support twice.", 1],
    ],
    labels: ["lbl-delivery", "lbl-follow"],
    assessed: [[0, "Complaint", true]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["joaquin.rv", "This blend is unreal. Best thing you've released this year ☕️🔥"]],
    sent: [[0, "Thank you, Joaquín! It goes fast — the roastery is already on batch four.", "Ana Ruiz"]],
    labels: ["lbl-praise"],
    assessed: [[0, "Praise", false]],
    flow: { done: "replied_publicly" },
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [
      ["Martina Gómez", "¿Van a tener opciones sin lactosa en el nuevo local? Mi hija es intolerante y siempre tenemos que preguntar."],
      ["Lucía Fernández", "En el de Belgrano tienen leche de avena y de almendras, supongo que acá también.", 0],
      ["Martina Gómez", "Gracias Lucía! Igual me gustaría que lo confirme la marca.", 1],
    ],
    labels: ["lbl-allergen"],
    assessed: [[0, "Question", false]],
    flow: { assignee: "m-ana", escalated: "Product" },
  },
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [["pedro.salles", "Cobraram o frete mesmo com a promoção. Quero o reembolso da diferença, por favor."]],
    labels: ["lbl-refund"],
    assessed: [[0, "Complaint", true]],
    flow: { assignee: "m-ana" },
  },
  {
    post: "post-4",
    account: "acc-fb-main",
    m: [
      ["Diego Herrera", "Do you sell green beans wholesale? We run two cafés in Montevideo and are looking for a new supplier for 2027."],
      ["@", "Hi Diego! Yes — our wholesale team will be glad to help. Could you share your weekly volume?"],
      ["Diego Herrera", "Around 40 kg a week between both places, mostly espresso. Do you deliver to Montevideo?", 1],
    ],
    labels: ["lbl-wholesale"],
    minutesAgo: 25,
    flow: { assignee: "m-carla" },
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [["Sofía Quiroga", "¿Quedan lugares para el sábado? El formulario no me deja anotarme."]],
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    // UX-04 scenario A: unanswered past the response target (4 h by default).
    m: [["nina.coffeelab", "Is the holiday blend available in whole bean or only ground?"]],
    minutesAgo: 250,
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [
      ["tomas.brews", "What's the recommended ratio for V60 with this one?"],
      ["@", "We like 1:16 with water at 93 °C. Let us know how it goes!"],
    ],
    flow: { done: "replied_on_platform" },
  },
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [["deals4u_official", "🔥 GET 90% OFF ALL COFFEE 🔥 visit our link in bio NOW", 0, "hidden"]],
    assessed: [[0, "Spam", false]],
    flow: { done: "moderated" },
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [
      ["Ramiro Paz", "El último pedido llegó con el paquete roto y la mitad del café desparramado en la caja. Pagué envío express para esto.", 0, "edited"],
      ["@", "Ramiro, lamentamos mucho lo ocurrido. Ya te escribimos por privado para reponer el pedido."],
      // UX-04 scenario B: the customer writes again after the brand's replies.
      ["Ramiro Paz", "Todavía no me llegó nada y nadie me contesta el privado. ¿Me van a devolver la plata o no?", 0],
    ],
    sent: [[0, "Ramiro, ya generamos la reposición sin costo. Te llega el lunes.", "Bruno Díaz"]],
    labels: ["lbl-delivery", "lbl-refund"],
    assessed: [[0, "Complaint", true]],
    // The customer's new reply is 40 minutes old (the last message of the seed's spacing is 18 minutes after it).
    minutesAgo: 22,
    flow: { assignee: "m-bruno", urgent: true },
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
      // UX-05-FINALFIX (R-1): a second reply by the same person under the same top-level comment — two distinct targets.
      ["camila.r", "Also: grind right before brewing, it makes a big difference.", 0],
      ["@", "Thanks Camila! Valen, a finer grind and 2–3 °C hotter water usually fixes it. Tell us if it doesn't."],
    ],
  },
  {
    post: "post-4",
    account: "acc-fb-main",
    m: [["Hernán Ortiz", "Video increíble. ¿Se puede visitar el tostadero?"]],
    flow: { done: "replied_on_platform" },
  },
  {
    post: "post-2",
    account: "acc-ig-main",
    m: [["luiza.mota", "Assinei semana passada e ainda não recebi o e-mail de confirmação 🤔"]],
    labels: ["lbl-follow"],
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [
      ["Paula Ibarra", "Fui al taller del mes pasado y fue lo mejor. 100% recomendado ❤️"],
      ["Sofía Quiroga", "¡Qué bueno! Me anoto para este.", 0],
    ],
    labels: ["lbl-praise"],
    flow: { done: "no_reply_needed" },
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [["andres.v", "Bought two bags and one was clearly stale. Not what I expect at this price.", 0, "removed"]],
    flow: { done: "no_reply_needed" },
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [["Gabriela Núñez", "¡Por fin en Palermo! ¿Abren los domingos?"]],
    sent: [[0, "¡Sí, Gabriela! Domingos de 9 a 19.", "Ana Ruiz"]],
    flow: { done: "replied_publicly" },
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["mateo.lopez", "Does the holiday blend contain any nuts or flavourings? My partner has a nut allergy."]],
    labels: ["lbl-allergen"],
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
    // Several labels on one conversation (UX-07B): the row shows two names and "+1"; the header shows all three.
    labels: ["lbl-delivery", "lbl-refund", "lbl-follow"],
    assessed: [[0, "Complaint", true], [5, "Commercial objection", true]],
    flow: { assignee: "m-bruno" },
  },
  {
    post: "post-4",
    account: "acc-fb-main",
    m: [["Julián Benítez", "¿Cuál es la diferencia entre el tueste medio y el oscuro en sabor?"]],
    flow: { done: "replied_on_platform" },
  },
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [["coffee.nerd.ba", "Huila washed is one of my favourites. What's the altitude for this lot?"]],
    sent: [[0, "1,750–1,900 m, from three farms around Pitalito.", "Bruno Díaz"]],
    flow: { done: "replied_publicly" },
  },
  {
    post: null,
    account: "acc-fb-main",
    m: [["Claudia Ríos", "Hola, ¿hacen facturas para empresa? Queremos pedir café para la oficina todos los meses."]],
    labels: ["lbl-wholesale"],
    flow: { assignee: "m-carla" },
  },
  {
    post: "post-11",
    account: "acc-ig-main",
    m: [["bia.carvalho", "Qual é o prazo de entrega para Porto Alegre?"]],
    flow: { done: "no_reply_needed" },
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
    labels: ["lbl-praise"],
    flow: { done: "no_reply_needed" },
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [
      ["Federico Luna", "La última vez me cobraron dos veces el mismo pedido en la tienda online. ¿A quién le escribo para que me devuelvan el cargo duplicado?"],
      ["@", "Federico, escribinos a ayuda@ con el comprobante y lo resolvemos hoy mismo."],
      ["Federico Luna", "Ya escribí ayer y no tuve respuesta.", 1],
    ],
    labels: ["lbl-refund", "lbl-follow"],
    assessed: [[0, "Complaint", true]],
    flow: { assignee: "m-bruno" },
  },
  {
    post: "post-10",
    account: "acc-ig-main",
    m: [["mica.ph", "Love the new packaging design!"]],
    flow: { done: "no_reply_needed" },
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
    flow: { done: "replied_privately" },
  },
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [["?", "Is this the same as last year's holiday blend or a new recipe?"]],
    flow: { done: "no_reply_needed" },
  },
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [["Silvia Acosta", "¿Tienen accesibilidad para silla de ruedas en el nuevo local?"]],
    flow: { done: "replied_on_platform" },
  },
  {
    post: "post-5",
    account: "acc-fb-events",
    m: [["Nicolás Ferreyra", "Hacen talleres para empresas? Somos un equipo de 15."]],
    labels: ["lbl-wholesale"],
    flow: { assignee: "m-carla" },
  },
  {
    post: "post-2",
    account: "acc-ig-main",
    m: [["clara.ok", "Cancelled my subscription and was still charged this month. Please refund."]],
    labels: ["lbl-refund"],
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
    flow: { done: "no_reply_needed" },
  },
  // UX-04: newer conversations, inside the response target — Open, but not Needs attention.
  { post: "post-1", account: "acc-ig-main", m: [["sol.marquez", "What grind would you recommend for a moka pot?"]], minutesAgo: 11 },
  { post: "post-3", account: "acc-fb-main", m: [["Pablo Ríos", "¿Tienen estacionamiento cerca del local de Palermo?"]], minutesAgo: 18 },
  // UX-04 scenario D: a spam comment on an organic Facebook post (every moderation action applies).
  { post: "post-3", account: "acc-fb-main", m: [["Café Barato Oficial", "ESTAFADORES!!! compren café de verdad en www.cafe-barato.xyz 🔥🔥 90% OFF solo hoy"]], minutesAgo: 20 },
  { post: "post-9", account: "acc-ig-main", m: [["marina.f", "Does the free shipping apply to Uruguay too?"]], minutesAgo: 33 },
  { post: "post-4", account: "acc-fb-main", m: [["Laura Sánchez", "¿El tostadero hace visitas guiadas para escuelas?"]], minutesAgo: 52 },
  // UX-04 scenario C: a second wholesale lead, already with sales.
  { post: "post-4", account: "acc-fb-main", m: [["Valeria Sosa", "¿Tienen precio mayorista para cafeterías? Somos tres locales en Rosario."]], labels: ["lbl-wholesale"], minutesAgo: 70, flow: { assignee: "m-carla" } },
  { post: "post-2", account: "acc-ig-main", m: [["rafa.coffee", "Can I pause my subscription in January? Travelling all month."]], labels: ["lbl-follow"], minutesAgo: 75 },
  { post: "post-6", account: "acc-ig-roastery", m: [["beto.gomez", "Is this lot available as an espresso roast?"]], minutesAgo: 95 },
  { post: "post-3", account: "acc-fb-main", m: [["Inés Paredes", "Excelente atención ayer en el local, ¡gracias Martín!"]], labels: ["lbl-praise"], minutesAgo: 130 },
  { post: "post-1", account: "acc-ig-main", m: [["dani.k", "Is there a decaf version of the holiday blend? 😅"]], minutesAgo: 160 },
  { post: "post-8", account: "acc-fb-main", m: [["Jorge Medina", "¿Hacen envíos a Mendoza para la caja de regalo?"]], minutesAgo: 190 },
  { post: "post-11", account: "acc-ig-main", m: [["ana.paula", "O gift card pode ser enviado por e-mail?"]], minutesAgo: 220 },
  /*
   * UX-08A: conversations from earlier months, for the date periods (the workspace's time zone decides which day, month
   * or year a moment belongs to; Buenos Aires is UTC−3).
   */
  // cv-49 — received last month and still open, never answered: an old backlog item an operational view must not hide.
  // Same post as cv-51, with a different label.
  {
    post: "post-8",
    account: "acc-fb-main",
    m: [["Marcos Villalba", "¿Siguen teniendo la caja de regalo grande? Necesito doce para fin de año, para el equipo de la oficina."]],
    labels: ["lbl-wholesale"],
    times: ["2026-10-14T13:05:00Z"],
  },
  // cv-50 — received last month, with activity this month (she wrote again on 16 November).
  {
    post: "post-9",
    account: "acc-ig-main",
    m: [
      ["lucia.bm", "My October order arrived without the grinder I paid for. Order #A-19877."],
      ["@", "So sorry, Lucía — we're sending the grinder this week."],
      ["lucia.bm", "Still waiting for the grinder — any news?", 1],
    ],
    labels: ["lbl-delivery"],
    times: ["2026-10-28T19:40:00Z", "2026-10-28T20:10:00Z", "2026-11-16T12:15:00Z"],
  },
  // cv-51 — received early this month, assigned to Ana. Same post as cv-49, with a different label.
  {
    post: "post-8",
    account: "acc-fb-main",
    m: [["Rocío Benítez", "Pedí la caja de regalo el 2 de noviembre y figura entregada, pero no llegó nada."]],
    labels: ["lbl-delivery"],
    times: ["2026-11-03T14:00:00Z"],
    flow: { assignee: "m-ana" },
  },
  // cv-52 — resolved in an earlier month (answered on the platform and marked Done on 2 October).
  {
    post: "post-6",
    account: "acc-ig-roastery",
    m: [
      ["nico.tostado", "Do you ship the Huila lot to Chile?"],
      ["@", "Not yet — only Argentina and Uruguay for now. We'll post here when that changes."],
    ],
    times: ["2026-10-02T14:00:00Z", "2026-10-02T14:20:00Z"],
    flow: { done: "replied_on_platform" },
  },
  // cv-53 — a month boundary: 1 November in UTC, still 31 October in Buenos Aires (22:30 and 23:05 there).
  {
    post: "post-1",
    account: "acc-ig-main",
    m: [
      ["mati.r", "Will the holiday blend come in whole bean too?"],
      ["@", "Yes — whole bean and ground, from Monday."],
    ],
    times: ["2026-11-01T01:30:00Z", "2026-11-01T02:05:00Z"],
  },
  // cv-54 — a year boundary: 1 January 2026 in UTC, still 31 December 2025 in Buenos Aires; resolved the same night.
  {
    post: "post-3",
    account: "acc-fb-main",
    m: [["Gabriela Ortiz", "¡Feliz año nuevo, equipo Lumen! Gracias por los cafés de todo el año 🥂"]],
    labels: ["lbl-praise"],
    times: ["2026-01-01T02:10:00Z"],
    flow: { done: "no_reply_needed" },
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
  const last = minutes(AS_OF, -(seed.minutesAgo ?? (12 + index * 47)) - (seed.daysAgo ?? 0) * 1440);
  const count = seed.m.length + (seed.sent?.length ?? 0);
  const start = minutes(last, -count * 16);
  const comments = seed.m.map(([code, text, parent, flag], position): Comment => {
    const at = seed.times?.[position] ?? minutes(start, position * 16 + (position % 3) * 7);
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

/** The labels already on conversations when the prototype starts: conversation id → label ids (UX-07B). */
export const SEED_ASSIGNMENTS: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, readonly string[]> = {};
  SEEDS.forEach((seed, index) => {
    if (seed.labels !== undefined && seed.labels.length > 0) out[`cv-${pad(index + 1)}`] = [...seed.labels];
  });
  return out;
})();

/** The seeded workflow of each conversation (UX-04): conversation id → what the seed says. */
export const SEED_FLOWS: Readonly<Record<string, NonNullable<Seed["flow"]>>> = (() => {
  const out: Record<string, NonNullable<Seed["flow"]>> = {};
  SEEDS.forEach((seed, index) => {
    if (seed.flow !== undefined) out[`cv-${pad(index + 1)}`] = seed.flow;
  });
  return out;
})();

/**
 * A public reply sent from Wrenkind earlier whose outcome is still unknown (UX-04: "Reply not confirmed"): conversation
 * cv-04, attached to its first comment, Checking until a person resolves it in the prototype.
 */
export const SEED_CHECKING_REPLY = { conversationId: "cv-04", commentId: "cv-04-m00", text: "Pedro, sentimos o problema — vamos devolver a diferença do frete hoje mesmo.", at: "2026-11-17T13:20:00Z" } as const;

/** The synthetic assessments (shown only when the prototype control asks for examples): comment id → assessment. */
export const SEED_ASSESSMENTS: Readonly<Record<string, Assessment>> = (() => {
  const out: Record<string, Assessment> = {};
  SEEDS.forEach((seed, index) => {
    for (const [position, meaning, isProtected] of seed.assessed ?? []) out[`cv-${pad(index + 1)}-m${pad(position)}`] = { meaning, protected: isProtected };
  });
  return out;
})();
