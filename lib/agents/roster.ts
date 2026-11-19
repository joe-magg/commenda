/**
 * Public, non-secret facts about the seeded agent roster: persona and a
 * stable display slot (for distinct marks). Addresses here are public.
 */
import agentConfig from "@/config/agents.json";
import { PERSONAS, type Persona } from "./strategy";

const ROSTER = agentConfig as { id: string; strategy?: string }[];

export function personaFor(agentId: string): Persona {
  const s = ROSTER.find((a) => a.id === agentId.toLowerCase())?.strategy;
  return (PERSONAS as readonly string[]).includes(s ?? "") ? (s as Persona) : "steady";
}

/** Index of a seeded agent in the roster, or -1 for agents created later. */
export function rosterIndex(agentId: string): number {
  return ROSTER.findIndex((a) => a.id === agentId.toLowerCase());
}
