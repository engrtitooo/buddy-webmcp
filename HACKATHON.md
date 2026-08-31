# Buddy — WebMCP Hackathon submission

## Tagline

**The friendly interface for the agentic web.**

## Problem

Websites are beginning to expose precise agent capabilities, but people should not have to understand protocol names, function schemas, or developer tooling. They need a companion that explains what is possible, accepts goals naturally, and carries personal safety rules across sites.

## Solution

Buddy is a small, original Chrome companion. It sleeps on ordinary sites, wakes on WebMCP sites, translates tools into human abilities, plans goal-oriented work, visibly performs safe steps, and pauses before consequential ones.

## Why WebMCP matters

Buddy never guesses selectors or treats screenshots as the action surface. It uses the website's intentional structured contracts. That makes actions more reliable, discoverable, auditable, and semantically clear than generic browser automation.

> WebMCP gives websites capabilities. Buddy gives those capabilities a face, a voice, and your rules.

## Technical innovation

- Consumer capability discovery rather than raw protocol inspection
- Dynamic `toolchange` awareness with immediate UI updates
- Model-independent planning over current tool definitions only
- Deterministic approval engine outside the language model
- Portable personal rules persisted locally across compatible sites
- Direct isolated-world WebMCP access with no unsafe page bridge
- Human activity trail separated from opt-in technical diagnostics
- One UI architecture across text, voice, RTL, light/dark, and reduced-motion modes

## Playground tools

| Tool | Kind | Visible effect |
|---|---|---|
| `search_items` | Read | Changes catalog results |
| `get_item_details` | Read | Returns one product |
| `filter_items` | Read | Narrows visible products |
| `compare_items` | Read | Opens comparison surface |
| `add_to_cart` | Write | Updates demo cart |
| `remove_from_cart` | Write | Updates demo cart |
| `get_cart` | Read | Returns cart and total |
| `set_delivery_preference` | Write | Updates delivery state |
| `prepare_checkout` | Read/preparation | Opens review state |
| `checkout` | Financial simulation | Completes no-charge demo order |

## Safety model

Each plan step has a deterministic risk class. User rules then produce allow, ask, or block. Approval cards show the action, reason, and relevant values outside ordinary chat. The website and model cannot change these rules. No real purchase exists in the Playground.

## Two-minute demo

1. Show Buddy sleeping on a normal site.
2. Open Buddy Market; Buddy wakes within a second.
3. Use the hero's suggested gift goal, by voice or text.
4. Point out the catalog updating during search/filter/compare.
5. Open Activity and show completed human-language steps.
6. Return to Chat as Buddy requests approval before adding the best choice.
7. First cancel to prove control; repeat and approve once.
8. Open the cart and show the result.
9. End on the tagline.

## Future vision

Buddy's interfaces can grow into encrypted preference sync, cross-site workflows, temporary permissions, spending limits, site trust scores, agent reputation, mobile integration, and multi-agent coordination without weakening the per-action approval boundary.
