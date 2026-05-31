// convex/telegram/registryCommands.ts
//
// The two built-in self-registration commands, packaged the same way as your
// feature commands (helloWorld/packList): a `buildRegistryCommands(scheduler)`
// factory returning CommandRegistrations. Concatenate them in convex/http.ts.
//
// `/register` → schedules registerChat (writes the telegramChats row + replies).
// `/start`    → schedules replyStartHelp (one-line intro pointing at /register).
//
// Both read chat context from the MessageContext the webhook passes to dispatch.

import type { Scheduler } from "convex/server";
import { internal } from "../_generated/api";
import type { CommandRegistration } from "./commands";

export function buildRegistryCommands(scheduler: Scheduler): CommandRegistration[] {
  return [
    {
      name: "register",
      dispatch: async (msg) => {
        await scheduler.runAfter(0, internal.telegram.chatRegistry.internal.registerChat, {
          chatId: msg.chatId,
          chatType: msg.chatType,
          title: msg.title,
          registeredBy: msg.fromId,
        });
      },
    },
    {
      name: "start",
      dispatch: async (msg) => {
        await scheduler.runAfter(0, internal.telegram.chatRegistry.internal.replyStartHelp, {
          chatId: msg.chatId,
        });
      },
    },
  ];
}
