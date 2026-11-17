# Comments — Competitive UX analysis (Step 7B-17V)

Status: **research input for the PO prototype review**. Not a decision document; it changes no approved document.

## How this was done, and its limits

- Read-only public research on 2026-11-17. No account was created, no trial was started, no product was tested.
  Nothing below claims to describe a screen we saw: it is what the vendors' own documentation says.
- Tags: **[DOC]** = stated by the cited source; **[INF]** = our UX reasoning from it.
- Two claims were spot-checked verbatim by a second read (SB-4 and AP-2). Every other finding comes from one read of the
  cited page.
- **Sprout Social:** every `support.sproutsocial.com` article returned HTTP 403. Sprout help evidence is the official
  articles' text as returned by a search engine (marked "snippet"). Only `sproutsocial.com/features/smart-inbox/` was
  read directly.
- **Independent evidence:** none. G2 and Capterra returned 403 and Reddit was not reachable, so this analysis has **no
  independent user evidence**. Every finding is vendor documentation plus our reasoning.
- **Video `youtube.com/watch?v=Gze0HY3cEa4`:** this is the official NapoleonCat video "Social Inbox: Full Walkthrough"
  (channel @NapoleonCat, identified by its oEmbed record). Its transcript and frames were not available, so none of its
  content is used.
- **Optional competitor:** Hootsuite was added for one distinct pattern only (HS-1).

## Findings

### CommentGuard

**CG-1 · Archive vs Bin**
- **Pattern:** [DOC] Archive moves a comment out of the inbox and "doesn't change the comment's status on the social
  platforms". Bin deletes the comment from the platform permanently.
- **Source:** help.commentguard.io/article/76-whats-the-difference-between-a-comment-in-the-archive-and-the-bin
  (official help)
- **Why it may work / problem solved:** [INF] It keeps internal triage apart from platform effect, so a queue can be
  cleared without moderating anything.
- **Limitations:** [INF] "Bin" suggests recoverable, but the delete is irreversible.
- **Learn:** keep an internal "done" separate from a provider action, with different words.
- **Do not copy:** a trash metaphor for an irreversible platform delete.

**CG-2 · Auto-hide marketing**
- **Pattern:**
  - [DOC] The product promises to "Auto-hide damaging comments", including "Negative comments in any language".
  - [DOC] It offers a "Hide all comments" mode.
  - [DOC] A hidden comment shows which filter hid it.
- **Source:** commentguard.io (official marketing); help.commentguard.io/article/64-how-to-setup-automated-comment-moderation
  (official help)
- **Why it may work:** [INF] Telling the person which filter acted explains an automated outcome.
- **Limitations:** [INF] Hiding negativity suppresses complaints.
- **Learn:** every automated outcome carries its reason.
- **Do not copy:** auto-hiding negativity and "hide all". Both contradict S1–S3 and S5.

**CG-3 · Mute a person**
- **Pattern:** [DOC] "All future comments from that specific user will be automatically hidden."
- **Source:** help.commentguard.io/article/133-what-does-the-mute-action-mean (official help)
- **Limitations:** [INF] It silently hides that person's future legitimate complaints.
- **Do not copy:** person-level blanket auto-hide (S2, S5).

**CG-4 · One composer with modes**
- **Pattern:**
  - [DOC] A "Send as private message" checkbox sits in the reply box, and a sent private reply is marked "(PM)".
  - [DOC] "Generate ✨" writes an AI reply.
  - [DOC] "Agents" can send AI replies automatically, with a delay.
- **Source:** help.commentguard.io articles 82, 65 and 83 (official help)
- **Learn:** keep a visible marker on what was sent, and in which channel.
- **Do not copy:** AI auto-send (S8). A checkbox that changes the destination is also easy to leave ticked by mistake.

**CG-5 · Ad vs organic as a filter**
- **Pattern:**
  - [DOC] A filter switches between ad comments and organic comments.
  - [DOC] The product "can't filter comments by campaign name".
  - [DOC] The person clicks the comment's preview to see its source post.
- **Source:** help.commentguard.io/article/141-how-to-show-comments-for-posts-or-ads-only (official help)
- **Learn:** organic/paid is a dimension (PD D-38).
- **Do not copy:** hiding the post context behind a click.

### Agorapulse

**AP-1 · Review as the completion state**
- **Pattern:**
  - [DOC] Two views: "Items to review" and "All items".
  - [DOC] An item is auto-reviewed when it is replied to, hidden or deleted in Agorapulse, but not when it is answered
    on the platform.
  - [DOC] "Review all" also covers items hidden by the current filters.
  - [DOC] Items hidden by automated moderation are not auto-reviewed.
- **Source:** support.agorapulse.com articles 10441656, 10420158 and 14658483 (official help)
- **Why it may work:** [INF] There is one clear done state, reached as a side effect of the natural action.
- **Limitations:** [INF]
  - The scope of "Review all" doesn't match what the person sees.
  - A human hide counts as reviewed but an automated hide doesn't.
- **Learn:** a human reply completes; anything automated stays reviewable.
- **Do not copy:** a bulk action that reaches beyond the visible, filtered set.

**AP-2 · Labels created and applied in the flow** (verified verbatim)
- **Pattern:**
  - [DOC] Steps: "Add label" icon → enter a name → "+ Create a new label". "The Inbox label will be created and
    automatically applied to the item being viewed."
  - [DOC] "Duplicate labels cannot be created."
  - [DOC] A deleted label "will be removed from any items it has been added to".
  - [DOC] Labels can be filtered on and reported, but are not searchable.
  - [DOC] Labels can't be created on mobile.
- **Source:** support.agorapulse.com/en/articles/10420408 and 10410740 (official help)
- **Learn:** inline create-and-apply with duplicate protection, and a filter by label. This is the PO's requirement,
  independently confirmed as an established workflow.
- **Do not copy:** a silent global delete that doesn't say how many items it affects.

**AP-3 · Icon actions per item**
- **Pattern:**
  - [DOC] Checkmark = Review, human = Assign, eye = Hide, trash = Delete (with "Yes I'm sure").
  - [DOC] A private reply sits under a split arrow next to Send.
- **Source:** support.agorapulse.com articles 10393493, 10393331 and 10441656 (official help)
- **Learn:** a secondary send mode is secondary in the layout, and irreversible actions are confirmed.
- **Do not copy:** an unlabeled icon row that mixes reversible and irreversible actions at equal weight.

**AP-4 · Who did what**
- **Pattern:**
  - [DOC] Attribution lives in Activity logs and in the export's "Team member" column (search snippets).
  - [DOC] Pending approvals show the triggering member "above the inbox item". The approval workflows article was read
    directly; it is not a snippet.
- **Source:** support.agorapulse.com articles 10443802 and 16357893 (official help)
- **Learn:** show the actor inline where a decision is made.
- **Do not copy:** attribution available only in exports.

**AP-5 · Sort, Post View, bulk, mobile**
- **Pattern:**
  - [DOC] Sorting is by date only.
  - [DOC] Post View groups items by post, with pending counts.
  - [DOC] Bulk checkboxes appear on hover.
  - [DOC] Mobile has neither bulk actions nor advanced filters.
  - [DOC] Moderation best practices suggest keyword rules such as "worst".
- **Source:** support.agorapulse.com articles 10410740, 10420158 and 14658483 (official help)
- **Learn:** a per-post pending count as navigation.
- **Do not copy:** keyword-as-meaning rules (S19).

### Sprout Social (help evidence from search snippets; pages returned 403)

**SP-1 · Mark complete**
- **Pattern:**
  - [DOC] A checkmark completes an item, and hovering it shows who completed it.
  - [DOC] Bulk completions "are not attributed to a specific user".
- **Source:** support.sproutsocial.com articles 360000576406 and 360007539072 (snippet); sproutsocial.com/features/smart-inbox
  (official, read)
- **Learn:** attribute every state change.
- **Do not copy:** unattributed bulk completion, and attribution that is visible on hover only.

**SP-2 · Keyboard mode**
- **Pattern:**
  - [DOC] Keyboard mode starts with Down Arrow and ends with Esc.
  - [DOC] An on-screen guide lists the keys.
- **Source:** support.sproutsocial.com article 205305545 (snippet)
- **Learn:** visible shortcut hints.
- **Do not copy:** a hidden modal entry into keyboard mode.

**SP-3 · Tags**
- **Pattern:**
  - [DOC] Tags are created inline from a message, up to 20 per message.
  - [DOC] Tags can be grouped into Tag Collections, and a filter can use a single tag or a whole collection.
  - [DOC] Auto-tagging rules exist on a higher plan.
- **Source:** support.sproutsocial.com articles 360058625851 and 24905615373325 (snippet)
- **Learn:** several labels per comment with a cap, and a filter by label.
- **Do not copy:** capabilities that silently change with the view (bulk tagging is unavailable in Conversation View).

**SP-4 · Reply identity, hide**
- **Pattern:**
  - [DOC] A profile selector above the composer chooses the responding Page.
  - [DOC] After a reply, hovering the shaded reply icon shows who sent it.
  - [DOC] "Hide on Facebook" sits in the overflow menu, and a banner shows a hidden comment with Unhide.
- **Source:** support.sproutsocial.com articles 115005887043 and 7759770232077 (snippet)
- **Learn:** the brand account is explicit in the composer, and hide lives in "More" with a visible, reversible state.
- **Do not copy:** "who replied" visible only on hover.

### NapoleonCat

**NC-1 · Ticket view, auto-assign, Done**
- **Pattern:**
  - [DOC] Tabs: Inbox, My Tasks, Flagged, Hidden, Deleted, Done, All.
  - [DOC] "Taking any action on a ticket will automatically assign it to you."
  - [DOC] One window shows all comments under a post.
  - [DOC] Each comment carries about a dozen controls, plus a moderation history.
- **Source:** brain.napoleoncat.com/en/articles/13832553-new-social-inbox-guide (official help)
- **Learn:** an explicit Done state, and a per-comment history.
- **Do not copy:** a dozen controls on every comment, and platform states (Hidden, Deleted) used as work queues.

**NC-2 · Message tags with type-ahead**
- **Pattern:**
  - [DOC] Tags apply to individual messages. A tag set on a conversation "applies it to every message".
  - [DOC] A filter matches a conversation when any one of its messages carries the tag.
  - [DOC] "Type part of a tag name and press Enter to apply it when only one tag matches."
  - [DOC] User tags label people.
- **Source:** brain.napoleoncat.com/en/articles/7979640; napoleoncat.com/updates-and-improvements (official)
- **Learn:** type-ahead plus Enter. **Adopted in the prototype.** The "any message matches" filter equals our §D.2.
- **Do not copy:** labelling people (privacy), and silent propagation from a conversation to its messages.

**NC-3 · Adjustable views**
- **Pattern:**
  - [DOC] The list/detail divider can be dragged, and also resized with the arrow keys.
  - [DOC] The CRM panel collapses to a strip.
  - [DOC] With the panel collapsed, tiles show Delete, Hide and Like directly.
- **Source:** napoleoncat.com/updates-and-improvements (official changelog)
- **Learn:** context panels that are optional, never permanent.
- **Do not copy:** irreversible actions on list tiles.

**NC-4 · Honest bulk counts**
- **Pattern:** [DOC] The tab badge counts the filtered view, while the bulk counter shows only what can be selected now.
- **Source:** napoleoncat.com/updates-and-improvements (official changelog)
- **Learn:** state the exact count before any bulk action (UX-06, UX-18).

### Statusbrew

**SB-1 · Engage layout and sorts**
- **Pattern:**
  - [DOC] Four parts: sidebar, list, conversation, and a details panel. The sidebar and details hide with `[` and `]`.
  - [DOC] Sorts include "Waiting longest" and "Priority first".
- **Source:** statusbrew.com/help/articles/engage-screen, …/keyboard-shortcuts (official help)
- **Learn:** a service-oriented "waiting longest" sort.
- **Do not copy:** a permanent multi-column default.

**SB-2 · Hover actions and permissions**
- **Pattern:**
  - [DOC] Hovering a message reveals about seven actions, and More holds Hide, Delete and private reply.
  - [DOC] The timestamp opens the message on the network.
  - [DOC] "Moderate Conversations" allows hide/delete/ban but "does not allow public replies".
- **Source:** statusbrew.com/help/articles/conversation-actions (official help)
- **Learn:** destructive actions sit one level down, and moderating and replying are separate permissions.
- **Do not copy:** a seven-icon hover bar, which doesn't work on touch or keyboard.

**SB-3 · States and shortcuts**
- **Pattern:**
  - [DOC] Open, Closed and Snoozed. A conversation reopens when the customer replies.
  - [DOC] "Reply & Close" and Add note; note mode is visually distinct.
  - [DOC] Shortcuts: j/k to move, o to open, y to close, ⌘/Ctrl+Enter to reply, ⌘/Ctrl+/ for the list.
- **Source:** statusbrew.com/help/articles/manage-conversations, …/conversation-reply-utilities, …/keyboard-shortcuts
  (official help)
- **Learn:** completion as part of replying, reopening on new inbound, and a discoverable cheat sheet.

**SB-4 · Brand as author, member as actor** (verified verbatim)
- **Pattern:**
  - [DOC] The reply shows "the name of the team member who sent the reply beneath the message".
  - [DOC] While a teammate is replying, their avatar appears with a typing indicator.
- **Source:** statusbrew.com/help/articles/agent-collision-detection (official help)
- **Learn:** exactly the split Wrenkind needs. The connected account is the public author; the member who requested the
  reply is a separate internal fact. **Adopted.**

**SB-5 · Governed tags**
- **Pattern:**
  - [DOC] Only Admins and Owners create tags; all users apply them.
  - [DOC] Tags can be created from the "Add tags" dialog.
  - [DOC] Automatic tag rules act on new messages only.
- **Source:** statusbrew.com/help/articles/internal-tags, …/bulk-actions-conversations (official help)
- **Learn:** role-gated creation inside the apply dialog (our §D.4), and forward-only rules (S21).

### Hootsuite (optional: one distinct pattern)

**HS-1 · A quiet text affordance per message**
- **Pattern:** [DOC] "Select Add tags below a comment or reply." The picker groups tags and can be searched.
- **Source:** help.hootsuite.com/hc/en-us/articles/20901921005979-Tag-posts-and-messages (official help)
- **Learn:** labelling sits at each comment as a quiet text action, not as one more icon in a row.

## The five most useful patterns

1. **Create a label where you work, and it is applied there** (AP-2, SB-5, SP-3): duplicate protection, several
   labels per item, filter by label, creation reserved to a governing role.
2. **The brand account is the public author, and the member is a separate internal fact** (SB-4, SP-4, AP-4).
3. **Destructive and provider actions one level down, with visible reversible states** (SB-2, SP-4, AP-3).
4. **Optional context, never a permanent extra column** (NC-3, SB-1).
5. **Keyboard triage with discoverable keys** (SB-3, SP-2, NC-2 type-ahead + Enter).

## Anti-patterns we reject

- Auto-hiding negativity, "hide all", muting a person (CG-2, CG-3): S1–S5.
- Keyword rules as meaning (AP-5): S19.
- AI auto-send with a delay (CG-4): S8.
- Bulk actions beyond the visible scope, or without attribution (AP-1, SP-1).
- Icon-only or hover-only action rows and attribution (AP-3, SB-2, SP-4).
- A permanent multi-column inbox (SB-1).
- Irreversible actions on list tiles, and "Bin" for a permanent delete (NC-3, CG-1).
- Labels on people, and silent propagation of labels (NC-2).
