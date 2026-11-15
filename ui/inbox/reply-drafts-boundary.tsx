"use client";
/**
 * The signed-out boundary of the reply drafts (Step 7B-15H). Sign-out (and an expired session) ends on a signed-out
 * surface — /sign-in, /sign-up, or "/" while signed out — through an in-app navigation, so this tab's memory would otherwise keep the
 * previous person's unsent replies. Drawn on those surfaces, it forgets every kept draft once it is shown, and with
 * them the leave confirmation. It renders nothing, reads nothing and sends nothing; a sign-out that fails never
 * reaches a signed-out surface, so the still-signed-in person keeps their drafts.
 */
import { useEffect } from "react";
import { clearReplyDrafts } from "./reply-drafts";

export function ReplyDraftsSignedOut(): null {
  useEffect(() => {
    clearReplyDrafts();
  }, []);
  return null;
}
