#!/usr/bin/env python3
"""Build the Brickwright visual guide as HTML, then print it to PDF."""

from __future__ import annotations

import html
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_HTML = Path(__file__).resolve().parent / "guide.html"
OUT_PDF = ROOT / "docs" / "how-brickwright-works.pdf"

CYAN = "#1A8A94"
ORANGE = "#C47A20"
GREEN = "#4A8A3A"
RED = "#C44A3A"
NAVY = "#0B1C24"
INK = "#1A2428"
MUTED = "#5A6B70"
PAPER = "#F7F4EE"
CARD = "#FFFFFF"
LINE = "#D5DDDF"
SOFT = "#E8EEEF"


def esc(text: str) -> str:
    return html.escape(text, quote=True)


def svg_defs() -> str:
    return f"""
<defs>
  <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
    <path d="M 0 1.2 L 10 5 L 0 8.8 z" fill="{NAVY}"/>
  </marker>
  <marker id="arr-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
    <path d="M 0 1.2 L 10 5 L 0 8.8 z" fill="{CYAN}"/>
  </marker>
  <marker id="arr-o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
    <path d="M 0 1.2 L 10 5 L 0 8.8 z" fill="{ORANGE}"/>
  </marker>
  <filter id="shadow" x="-8%" y="-8%" width="116%" height="124%">
    <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#0B1C24" flood-opacity="0.12"/>
  </filter>
</defs>
"""


def box(
    x: float,
    y: float,
    w: float,
    h: float,
    title: str,
    body: str = "",
    fill: str = CARD,
    stroke: str = LINE,
    accent: str | None = None,
    title_size: int = 13,
    body_size: int = 11,
    title_fill: str = INK,
    body_fill: str = MUTED,
) -> str:
    r = 8
    accent_bar = ""
    if accent:
        accent_bar = f'<rect x="{x}" y="{y}" width="5" height="{h}" rx="2.5" fill="{accent}"/>'
        title_x = x + 16
    else:
        title_x = x + 12
    body_el = ""
    if body:
        lines = body.split("\n")
        tspan = "".join(
            f'<tspan x="{title_x}" dy="{16 if i else 0}">{esc(line)}</tspan>' for i, line in enumerate(lines)
        )
        body_el = f'<text x="{title_x}" y="{y + 38}" font-size="{body_size}" fill="{body_fill}">{tspan}</text>'
    title_y = y + (22 if body else h / 2 + 5)
    return f"""
<g filter="url(#shadow)">
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="1.25"/>
  {accent_bar}
  <text x="{title_x}" y="{title_y}" font-size="{title_size}" font-weight="650" fill="{title_fill}">{esc(title)}</text>
  {body_el}
</g>
"""


def dark_box(x: float, y: float, w: float, h: float, title: str, body: str = "") -> str:
    return box(
        x,
        y,
        w,
        h,
        title,
        body,
        fill=NAVY,
        stroke=NAVY,
        title_fill=PAPER,
        body_fill="#B7C6C9",
    )


def pill(x: float, y: float, w: float, h: float, label: str, fill: str, text: str = "#fff") -> str:
    return f"""
<g>
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h/2}" fill="{fill}"/>
  <text x="{x + w/2}" y="{y + h/2 + 4}" text-anchor="middle" font-size="12" font-weight="650" fill="{text}">{esc(label)}</text>
</g>
"""


def diamond(cx: float, cy: float, w: float, h: float, label: str, fill: str = "#FFF8ED", stroke: str = ORANGE) -> str:
    pts = f"{cx},{cy - h/2} {cx + w/2},{cy} {cx},{cy + h/2} {cx - w/2},{cy}"
    return f"""
<g filter="url(#shadow)">
  <polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>
  <text x="{cx}" y="{cy + 4}" text-anchor="middle" font-size="11.5" font-weight="650" fill="{INK}">{esc(label)}</text>
</g>
"""


def arrow(x1: float, y1: float, x2: float, y2: float, marker: str = "arr", color: str = NAVY, dashed: bool = False) -> str:
    dash = 'stroke-dasharray="5 4"' if dashed else ""
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1.6" {dash} marker-end="url(#{marker})"/>'


def label(x: float, y: float, text: str, color: str = MUTED, size: int = 10, anchor: str = "middle") -> str:
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" fill="{color}">{esc(text)}</text>'


def caption(text: str) -> str:
    return f'<p class="caption">{esc(text)}</p>'


def diagram(width: int, height: int, inner: str, fig: str) -> str:
    return f"""
<figure class="diagram">
  <svg viewBox="0 0 {width} {height}" width="100%" role="img" aria-label="{esc(fig)}">
    {svg_defs()}
    {inner}
  </svg>
  {caption(fig)}
</figure>
"""


def d_big_idea() -> str:
    inner = f"""
{pill(268, 8, 184, 28, "The only source of truth", NAVY)}
{box(40, 56, 150, 70, "A person", "Clicks, drags, types\\nin the 3D editor", accent=ORANGE)}
{box(530, 56, 150, 70, "An AI agent", "Talks, searches,\\nproposes, captures", accent=CYAN)}
{box(250, 150, 220, 64, "Command bus", "Same typed operations, always", accent=NAVY)}
{box(250, 244, 220, 64, "CAD kernel", "Guards, snaps, collides, revises", accent=CYAN)}
{box(250, 338, 220, 72, "The model document", "Parts, connections, revision N", accent=GREEN)}
{box(40, 448, 150, 62, "3D viewport", "A disposable picture", accent=ORANGE)}
{box(245, 448, 115, 62, "Local save", "IndexedDB log", accent=NAVY)}
{box(385, 448, 115, 62, "Cloud copy", "Convex replica", accent=CYAN)}
{box(530, 448, 150, 62, "Share page", "Frozen snapshot", accent=GREEN)}
{arrow(115, 126, 250, 168)}
{arrow(605, 126, 470, 168, "arr-c", CYAN)}
{arrow(360, 214, 360, 244)}
{arrow(360, 308, 360, 338)}
{arrow(300, 410, 115, 448, dashed=True)}
{arrow(330, 410, 302, 448, dashed=True)}
{arrow(390, 410, 442, 448, dashed=True)}
{arrow(430, 410, 605, 448, dashed=True)}
{label(360, 236, "one atomic batch")}
{label(200, 432, "derived views — never the original", 10)}
"""
    return diagram(720, 530, inner, "Everything you see is a view of one document. Humans and the agent edit it the same way.")


def d_product_map() -> str:
    inner = f"""
{box(270, 8, 180, 52, "Landing  /", "What Brickwright is", accent=NAVY)}
{box(20, 100, 150, 62, "Explore", "Browse real parts\\nand demos", accent=ORANGE)}
{box(190, 100, 150, 62, "Editor", "The CAD cockpit.\\nNeeds the full kernel.", accent=CYAN)}
{box(360, 100, 150, 62, "Projects", "Your saved models.\\nSign-in required.", accent=GREEN)}
{box(530, 100, 170, 62, "Gallery", "Public publications.\\nNo catalog download.", accent=ORANGE)}
{box(105, 210, 170, 62, "Account", "Sign in, profile.\\nHexclave identity.", accent=NAVY)}
{box(310, 210, 170, 62, "Share /slug", "Read-only viewer of\\none frozen revision.", accent=CYAN)}
{arrow(360, 60, 95, 100)}
{arrow(360, 60, 265, 100)}
{arrow(360, 60, 435, 100)}
{arrow(360, 60, 615, 100)}
{arrow(265, 162, 190, 210)}
{arrow(435, 162, 395, 210)}
{label(360, 90, "routes in the app shell", size=11)}
{box(20, 310, 680, 70, "How much loads before the page paints",
     "Landing / Gallery / Account  →  almost nothing     ·     Explore / Projects / Share  →  the part catalog     ·     Editor  →  catalog + kernel + your session",
     fill=SOFT, stroke=LINE)}
"""
    return diagram(720, 400, inner, "Each page only downloads what it needs. Opening the marketing site never loads a LEGO catalog.")


def d_place_brick() -> str:
    inner = f"""
{pill(20, 22, 88, 28, "1  Pick", ORANGE)}
{box(20, 62, 150, 70, "Choose a part", "Must be placeable:\\nreal compiled geometry", accent=ORANGE)}
{pill(190, 22, 88, 28, "2  Aim", CYAN)}
{box(190, 62, 150, 70, "Click in the 3D view", "A ray hits a brick\\nor the ground plane", accent=CYAN)}
{pill(360, 22, 110, 28, "3  Resolve", GREEN)}
{box(360, 62, 160, 70, "Placement solver", "Same code that will\\ncommit the pose", accent=GREEN)}
{diamond(620, 97, 150, 86, "Legal pose?")}
{arrow(170, 97, 190, 97)}
{arrow(340, 97, 360, 97)}
{arrow(520, 97, 545, 97)}
{box(20, 190, 200, 70, "Ghost preview", "Green if it will clutch.\\nRed if blocked, with a reason.", accent=NAVY)}
{box(260, 190, 200, 70, "Commit click / Enter", "One CadOperation batch:\\npart.add + connections", accent=CYAN)}
{box(500, 190, 200, 70, "Revision N + 1", "Undoable transaction.\\nAutosaved locally.", accent=GREEN)}
{arrow(620, 140, 120, 190, dashed=True)}
{label(370, 172, "yes — show a ghost", size=11)}
{arrow(220, 260, 260, 225)}
{arrow(460, 225, 500, 225)}
{box(190, 290, 340, 58, "No: occupied, incompatible, collision, or no clutch", "The brick is not placed. The document does not change.", fill="#FDF2F0", stroke=RED)}
{arrow(620, 140, 360, 290, "arr", RED, dashed=True)}
"""
    return diagram(720, 370, inner, "Placing a brick is not a graphics trick. The ghost you see is the kernel’s real answer.")


def d_revision() -> str:
    inner = f"""
{box(20, 30, 180, 80, "Read revision 12", "Human or agent looks\\nat the model as it is", accent=NAVY)}
{box(270, 30, 180, 80, "Plan an edit", "expectedRevision = 12\\nplus typed operations", accent=ORANGE)}
{diamond(560, 70, 170, 90, "Still 12?")}
{arrow(200, 70, 270, 70)}
{arrow(450, 70, 475, 70)}
{box(80, 180, 220, 78, "Apply atomically", "Revision becomes 13.\\nOne undo step. Connections\\nupdated with the edit.", fill="#F1F8F2", stroke=GREEN, accent=GREEN)}
{box(420, 180, 260, 78, "Refuse: STALE_REVISION", "Someone else (or you) already\\nedited. Repair: re-read, replan.", fill="#FDF2F0", stroke=RED, accent=RED)}
{arrow(520, 115, 190, 180, "arr", GREEN)}
{label(300, 160, "yes", GREEN, 11)}
{arrow(600, 115, 550, 180, "arr", RED)}
{label(640, 160, "no", RED, 11)}
"""
    return diagram(720, 280, inner, "Edits are optimistic and strict. A stale plan fails with a repair hint instead of overwriting.")


def d_catalog() -> str:
    inner = f"""
{box(20, 16, 200, 64, "LDraw library", "Shapes, colours, part ids\\nCC BY 4.0", accent=ORANGE)}
{box(250, 16, 220, 64, "LDCad Shadow Library", "How studs, pins, hinges mate\\nCC BY-SA 4.0", accent=CYAN)}
{box(500, 16, 200, 64, "Rebrickable catalogue", "Names, sets, colour evidence\\nbulk CSV", accent=GREEN)}
{arrow(120, 80, 360, 118)}
{arrow(360, 80, 360, 118)}
{arrow(600, 80, 360, 118)}
{dark_box(160, 118, 400, 52, "Offline compiler  ·  catalog 2026-07", "Hashes every file. Missing assets → the app will not start.")}
{box(20, 200, 210, 110, "Placeable  ·  900", "Compiled mesh + connectors.\\nYou can build with these.", fill="#E8F6F7", stroke=CYAN, accent=CYAN)}
{box(255, 200, 210, 110, "Modelled  ·  22,041", "LDraw knows the shape.\\nThis build has no mesh yet.", fill="#FFF6EA", stroke=ORANGE, accent=ORANGE)}
{box(490, 200, 210, 110, "Catalogued  ·  58,833", "It is a real LEGO part.\\nNothing else is known here.", fill="#F1F8F2", stroke=GREEN, accent=GREEN)}
{arrow(280, 168, 125, 200)}
{arrow(360, 168, 360, 200)}
{arrow(440, 168, 595, 200)}
"""
    return diagram(
        720,
        330,
        inner,
        "Search always says which tier it found. “Never heard of it” and “real, but not placeable” are different answers.",
    )


def d_snap() -> str:
    inner = f"""
{box(20, 20, 200, 86, "Moving brick", "Has anti-studs, pin holes…\\nEach connector is a little\\ncoordinate frame.", accent=ORANGE)}
{box(500, 20, 200, 86, "Target brick", "Has studs, pins, hinges…\\nalready sitting in the model.", accent=CYAN)}
{box(230, 140, 260, 70, "Find compatible pairs", "Opposite gender, same family,\\nnot already occupied.", accent=NAVY)}
{box(230, 240, 260, 78, "Compose one rigid pose", "Tm = Tt · Ft · C · Fm⁻¹\\nPosition and rotation together.", fill="#E8F6F7", stroke=CYAN, accent=CYAN)}
{box(20, 350, 210, 70, "Score extra mates", "A 2×4 should sit on\\neight studs, not one.", accent=GREEN)}
{box(255, 350, 210, 70, "Axes must align", "A sideways stud through\\nan anti-stud is not a mate.", accent=ORANGE)}
{box(490, 350, 210, 70, "Keep the best pose", "That is what the ghost\\nshows, and what commits.", accent=CYAN)}
{arrow(220, 63, 500, 63, dashed=True)}
{arrow(120, 106, 230, 160)}
{arrow(600, 106, 490, 160)}
{arrow(360, 210, 360, 240)}
{arrow(300, 318, 125, 350)}
{arrow(360, 318, 360, 350)}
{arrow(420, 318, 595, 350)}
"""
    return diagram(720, 440, inner, "Snapping is frame algebra, not “move until it looks close.” Hinges and Technic pins use the same formula as stacking.")


def d_collision() -> str:
    inner = f"""
{pill(40, 18, 200, 30, "1  Cheap boxes", NAVY)}
{box(40, 58, 200, 72, "World AABBs overlap?", "Fast. Many false alarms —\\na rotated brick’s box is huge.", accent=NAVY)}
{pill(260, 18, 200, 30, "2  Legal clutch", CYAN)}
{box(260, 58, 200, 72, "Mating clearance", "Studs are supposed to go\\ninto tubes. Subtract that.", accent=CYAN)}
{pill(480, 18, 200, 30, "3  Real triangles", GREEN)}
{box(480, 58, 200, 72, "BVH confirmation", "Do the actual surfaces meet?\\nCached per part definition.", accent=GREEN)}
{arrow(240, 94, 260, 94)}
{arrow(460, 94, 480, 94)}
{box(40, 170, 200, 64, "exact", "Triangles met.\\nNo allowance used.", fill="#E8F6F7", stroke=CYAN)}
{box(260, 170, 200, 64, "clearance-subtracted", "Triangles met after\\nallowing the clutch.", fill="#FFF6EA", stroke=ORANGE)}
{box(480, 170, 200, 64, "unknown", "Mesh not loaded.\\nOnly boxes were compared.", fill="#FDF2F0", stroke=RED)}
{label(360, 255, "The UI always shows which kind of answer you got. A box-only hit is never dressed up as proof.", size=11)}
"""
    return diagram(720, 275, inner, "Collision is honest about its certainty. A stacked brick is not reported as broken just because the studs occupy the tubes.")


def d_validation() -> str:
    inner = f"""
{box(20, 16, 680, 44, "After every committed edit the kernel re-derives what the model physically is", fill=SOFT)}
{box(20, 80, 150, 88, "Connections", "Mated connector\\npairs, with joint\\nfreedom", accent=CYAN)}
{box(186, 80, 150, 88, "Components", "Which bricks form\\none clutched piece\\nvs loose groups", accent=NAVY)}
{box(352, 80, 150, 88, "Weak points", "Only one neighbour\\n— easy to knock off", accent=ORANGE)}
{box(518, 80, 182, 88, "Statics", "Mass, centre of mass,\\nsupport polygon,\\nhanging loads", accent=GREEN)}
{box(20, 190, 215, 72, "Colour evidence", "Unknown pairings are\\nvirtual, not illegal.", accent=NAVY)}
{box(252, 190, 215, 72, "Hard constraints", "Palette, size, budget,\\nlocked regions.", accent=RED)}
{box(484, 190, 216, 72, "Build order", "Every step must attach\\nto what is already built.", accent=CYAN)}
"""
    return diagram(720, 280, inner, "Health is measured from the connection graph and the compiled solids — not from how pretty the render looks.")


def d_assembly() -> str:
    inner = f"""
{box(20, 16, 160, 78, "build_wall", "Bonded courses,\\nopenings, bridging\\nabove doors", accent=ORANGE)}
{box(196, 16, 160, 78, "build_enclosure", "Four walls whose\\ncorners interlock,\\non a deck", accent=CYAN)}
{box(372, 16, 160, 78, "build_structure", "Storeys, windows,\\ndoor, band, roof\\nparapet", accent=GREEN)}
{box(548, 16, 152, 78, "build_field", "Floor or roof,\\ncross-bonded into\\na rigid slab", accent=NAVY)}
{arrow(100, 94, 360, 128)}
{arrow(276, 94, 360, 128)}
{arrow(452, 94, 360, 128)}
{arrow(624, 94, 360, 128)}
{dark_box(160, 128, 400, 56, "Ordinary part.add operations", "Still one transaction, still snapped, still collision-checked.")}
{box(20, 210, 220, 70, "stack_selection", "Repeat a storey upward\\non its own mating planes", accent=ORANGE)}
{box(250, 210, 220, 70, "capture_module", "Save a bay in its own\\nlocal frame", accent=CYAN)}
{box(480, 210, 220, 70, "stamp_module", "Place copies, rotate\\nabout the footprint", accent=GREEN)}
"""
    return diagram(720, 300, inner, "A language model is bad at laying a bonded wall brick by brick. These planners do the bricklaying; the kernel still checks the result.")


def d_local_cloud() -> str:
    inner = f"""
{box(20, 20, 210, 90, "You click  (or the agent is accepted)", "Command bus → kernel\\ncommits revision N+1", accent=ORANGE)}
{box(255, 20, 210, 90, "IndexedDB first", "Append the transaction\\nto a local log. Periodic\\ncheckpoint. Always.", accent=NAVY)}
{box(490, 20, 210, 90, "Outbox", "If you are signed in,\\nqueue the same edit\\nfor the cloud.", accent=CYAN)}
{arrow(230, 65, 255, 65)}
{arrow(465, 65, 490, 65)}
{diamond(360, 175, 160, 80, "Online + auth?")}
{arrow(595, 110, 440, 155, dashed=True)}
{box(20, 250, 300, 86, "Convex compare-and-advance", "baseRevision must match the branch head.\\nBatches of up to 50 edits. No last-write-wins.", fill="#E8F6F7", stroke=CYAN, accent=CYAN)}
{box(400, 250, 300, 86, "Keep working locally", "Offline, signed-out, or unconfigured\\nare normal. The editor does not freeze.", fill="#FFF6EA", stroke=ORANGE, accent=ORANGE)}
{arrow(310, 200, 170, 250, "arr-c", CYAN)}
{arrow(410, 200, 550, 250, "arr-o", ORANGE)}
"""
    return diagram(720, 360, inner, "The cloud is a replica, not the original. Your edit is durable on this computer even if the network is gone.")


def d_identity() -> str:
    inner = f"""
{dark_box(200, 8, 320, 56, "Hexclave  ·  identity plane", "Users, sessions, email, analytics")}
{box(20, 90, 200, 78, "Password / OTP / passkey", "or Google / GitHub", accent=ORANGE)}
{box(260, 90, 200, 78, "Signed-in user id", "The token’s sub claim.\\nNever an email for auth.", accent=CYAN)}
{box(500, 90, 200, 78, "Emails", "Invites, receipts.\\nNative Hexclave send.", accent=GREEN)}
{arrow(360, 64, 120, 90)}
{arrow(360, 64, 360, 90)}
{arrow(360, 64, 600, 90)}
{box(80, 200, 250, 78, "Browser app", "Account menu, /account,\\nguards on /projects", accent=NAVY)}
{box(390, 200, 250, 78, "Convex membership", "Roles on the project.\\nOwner / editor / viewer…", accent=CYAN)}
{arrow(160, 168, 180, 200)}
{arrow(360, 168, 515, 200, "arr-c", CYAN)}
"""
    return diagram(720, 300, inner, "Who you are and what the model is are separate planes. Cloud writes still check the Hexclave token.")


def d_assistant() -> str:
    inner = f"""
{box(20, 16, 160, 70, "You type", "“Put a red door\\nin that wall.”", accent=ORANGE)}
{box(210, 16, 180, 70, "Browser session", "Adds grounding:\\nrevision, selection,\\ncatalog version", accent=NAVY)}
{box(420, 16, 140, 70, "API process", "Holds the model\\nkey. No document.", accent=CYAN)}
{box(590, 16, 110, 70, "Anthropic", "Streams a reply\\nand tool calls", accent=GREEN)}
{arrow(180, 51, 210, 51)}
{arrow(390, 51, 420, 51)}
{arrow(560, 51, 590, 51)}
{box(210, 120, 350, 56, "If the model asked for tools: the browser runs them on the real kernel", fill=SOFT)}
{box(20, 200, 210, 78, "Reads and preflights only", "Inspect parts, search,\\nghost a proposal.\\nNo commit tool.", accent=CYAN)}
{box(255, 200, 210, 78, "A reviewable wave", "You see what would\\nchange. Accept or skip.", accent=ORANGE)}
{box(490, 200, 210, 78, "Then the kernel", "Same expectedRevision\\nguard as a mouse click.", accent=GREEN)}
{arrow(385, 176, 125, 200, dashed=True)}
{arrow(385, 176, 360, 200)}
{arrow(465, 239, 490, 239)}
{label(360, 300, "Build mode can auto-apply a wave — through the same accept function, with the same re-check.", size=11)}
"""
    return diagram(720, 320, inner, "The language model never holds the bricks. Tools run in your browser; the API process only talks to the model.")


def d_autonomy() -> str:
    inner = f"""
{box(20, 20, 220, 120, "Inspect", "Read the model.\\nSearch the catalog.\\nCapture the viewport.\\nCannot change a brick.", fill="#E8F6F7", stroke=CYAN, accent=CYAN)}
{box(250, 20, 220, 120, "Propose", "Everything in Inspect,\\nplus ghosts and preflight.\\nStill cannot commit.", fill="#FFF6EA", stroke=ORANGE, accent=ORANGE)}
{box(480, 20, 220, 120, "Build", "Writes, undo, generate,\\nopen projects — still via\\nthe kernel’s guards.", fill="#F1F8F2", stroke=GREEN, accent=GREEN)}
{label(360, 170, "Switching mode unregisters the extra tools before the new set is installed.", size=11)}
{box(120, 190, 480, 50, "WebMCP / ChatGPT Site Tools see the same inventory as the in-page agent", fill=SOFT)}
"""
    return diagram(720, 260, inner, "Autonomy is a tool inventory, not a promise. Protected parts and collisions are enforced even in Build mode.")


def d_generation() -> str:
    inner = f"""
{pill(30, 16, 130, 28, "1  Brief", ORANGE)}
{box(20, 52, 160, 72, "Words → brief", "Subject, scale, colours.\\nConflicts are kept,\\nnot silently picked.", accent=ORANGE)}
{pill(210, 16, 130, 28, "2  Graph", CYAN)}
{box(200, 52, 160, 72, "Build graph", "Intents + attachments.\\nNo world coordinates\\nfrom the model.", accent=CYAN)}
{pill(390, 16, 130, 28, "3  Realize", GREEN)}
{box(380, 52, 160, 72, "Snap into poses", "Kernel solver places\\neach attachment.\\nWalls use planners.", accent=GREEN)}
{pill(570, 16, 130, 28, "4  Keep", NAVY)}
{box(560, 52, 140, 72, "Hard gates", "Collision, clutch,\\nstatics, build order.", accent=NAVY)}
{arrow(180, 88, 200, 88)}
{arrow(360, 88, 380, 88)}
{arrow(540, 88, 560, 88)}
{box(80, 160, 560, 70, "Several different strategies, not several looks at the same idea",
     "Each candidate is hashed by structure. You compare, then apply one transaction — or none.", fill=SOFT)}
"""
    return diagram(720, 250, inner, "A generated model is not a pile of guessed coordinates. The AI proposes structure; the kernel decides where every brick sits.")


def d_refinement() -> str:
    inner = f"""
{box(20, 20, 160, 78, "Select a region", "And say what you\\nwant in words", accent=ORANGE)}
{box(210, 20, 160, 78, "Analyse", "Located findings:\\nweak, ugly, heavy,\\nasymmetric…", accent=CYAN)}
{box(400, 20, 140, 78, "Propose ghosts", "Restack, simplify,\\nreinforce, symmetrize…", accent=GREEN)}
{box(560, 20, 140, 78, "Score vector", "Every metric, including\\nregressions", accent=NAVY)}
{arrow(180, 59, 210, 59)}
{arrow(370, 59, 400, 59)}
{arrow(540, 59, 560, 59)}
{box(160, 130, 400, 64, "Nothing is committed until you apply", "applyRefinement goes through the command bus with that proposal’s base revision.", fill="#E8F6F7", stroke=CYAN)}
"""
    return diagram(720, 220, inner, "Refinement is a design doctor: it measures a patch of the model and offers ranked, already-checked alternatives.")


def d_share() -> str:
    inner = f"""
{box(20, 16, 200, 80, "Live document", "Keeps changing as\\nyou edit", accent=ORANGE)}
{box(260, 16, 200, 80, "Publication", "Exact revision, frozen.\\nPrivate notes stripped.\\nContent-hashed.", accent=CYAN)}
{box(500, 16, 200, 80, "Share page", "Edge-rendered HTML.\\nRead-only viewer.\\nOptional fork.", accent=GREEN)}
{arrow(220, 56, 260, 56)}
{arrow(460, 56, 500, 56)}
{box(20, 120, 150, 64, "private", "Only you", fill=SOFT)}
{box(190, 120, 160, 64, "unlisted", "Unguessable link,\\nrevocable", fill="#FFF6EA", stroke=ORANGE)}
{box(370, 120, 150, 64, "public", "Gallery + search", fill="#E8F6F7", stroke=CYAN)}
{box(540, 120, 160, 64, "Cannot mutate", "Viewer imports no\\nengine or command bus", fill="#F1F8F2", stroke=GREEN)}
"""
    return diagram(720, 210, inner, "Sharing copies a moment in time. Editing the original afterwards cannot rewrite a published link.")


def d_deploy() -> str:
    inner = f"""
{dark_box(20, 16, 680, 40, "The browser only ever talks to brickwrite.tech")}
{box(20, 80, 210, 100, "Cloudflare Pages", "Static app + catalog.\\nEdge functions proxy /api\\nand render share pages.", accent=ORANGE)}
{box(255, 80, 210, 100, "Vercel  ·  Node API", "Assistant + generation.\\nHolds model keys.\\nRejects unproxied calls.", accent=CYAN)}
{box(490, 80, 210, 100, "Convex", "Projects, history,\\nmembers, comments,\\npresence.", accent=GREEN)}
{box(150, 210, 420, 70, "Hexclave", "Identity for all three. Trusted domains are environment config, not the git branch.", fill=SOFT, accent=NAVY)}
{arrow(125, 180, 280, 210, dashed=True)}
{arrow(360, 180, 360, 210, dashed=True)}
{arrow(595, 180, 440, 210, dashed=True)}
"""
    return diagram(720, 300, inner, "Three services, three kinds of secret. A CAD session without Hexclave or Convex still works — just local, with no account.")


def d_boot() -> str:
    inner = f"""
{box(20, 24, 140, 96, "none", "HTML chrome only.\\nLanding, gallery,\\naccount.", fill=SOFT, accent=NAVY)}
{box(220, 24, 180, 96, "catalog", "Fetch + verify the\\ncompiled part library.\\nExplore, projects, share.", fill="#E8F6F7", stroke=CYAN, accent=CYAN)}
{box(460, 24, 240, 96, "editor", "Catalog + CAD kernel +\\nIndexedDB session +\\nwarmed meshes.", fill="#FFF6EA", stroke=ORANGE, accent=ORANGE)}
{arrow(160, 72, 220, 72)}
{arrow(400, 72, 460, 72)}
{label(360, 145, "A route cannot promote itself. That is what keeps the home page light.", size=11)}
"""
    return diagram(720, 170, inner, "Boot is staged. If a page declared it needs the catalog and the files are missing, it refuses rather than inventing parts.")


def d_code_map() -> str:
    rows = [
        ("src/cad", "The kernel: document, snap, collision, assembly, save"),
        ("src/editor", "The cockpit: viewport, panels, gizmos, keyboard"),
        ("src/webmcp", "The tool surface humans and agents share"),
        ("src/agent + server/assistant", "Chat loop; tools in the browser, key on the server"),
        ("src/generation", "Sentence → brief → graph → realised bricks"),
        ("src/refinement", "Design doctor on a selected region"),
        ("src/intelligence", "Smarter part finding than keyword search"),
        ("src/cloud + convex", "Replica, membership, history, invites"),
        ("src/features", "Landing, explore, share, gallery, projects"),
        ("src/platform + hexclave", "Shell, routes, boot, accounts"),
        ("tools/", "Catalog compiler and browser acceptance tests"),
        ("functions/ + api/", "Edge proxy, share HTML, Vercel adapters"),
    ]
    inner = []
    y = 8
    for i, (left, right) in enumerate(rows):
        bg = CARD if i % 2 == 0 else SOFT
        inner.append(f'<rect x="20" y="{y}" width="680" height="28" rx="6" fill="{bg}"/>')
        inner.append(f'<text x="36" y="{y + 18}" font-size="12" font-weight="650" font-family="JetBrains Mono, monospace" fill="{CYAN}">{esc(left)}</text>')
        inner.append(f'<text x="268" y="{y + 18}" font-size="12" fill="{INK}">{esc(right)}</text>')
        y += 30
    return diagram(720, y + 8, "\n".join(inner), "Ten workstreams. Each owns a folder. The kernel is imported; it is never rewritten from a feature.")


def d_journey() -> str:
    inner = f"""
{pill(20, 20, 28, 28, "1", ORANGE)}
{box(56, 12, 150, 44, "Open the editor", "Last project restores", accent=ORANGE)}
{pill(226, 20, 28, 28, "2", CYAN)}
{box(262, 12, 150, 44, "Search  2x4", "Pick a placeable hit", accent=CYAN)}
{pill(432, 20, 28, 28, "3", GREEN)}
{box(468, 12, 230, 44, "Click the ground", "Ghost snaps · click commits", accent=GREEN)}
{pill(20, 84, 28, 28, "4", NAVY)}
{box(56, 76, 200, 44, "Drag with the gizmo", "One transaction on release", accent=NAVY)}
{pill(276, 84, 28, 28, "5", ORANGE)}
{box(312, 76, 180, 44, "Validate / health", "Connections and collisions", accent=ORANGE)}
{pill(512, 84, 28, 28, "6", CYAN)}
{box(548, 76, 150, 44, "Export .ldr / BOM", "Or publish a share", accent=CYAN)}
{arrow(206, 34, 226, 34)}
{arrow(412, 34, 432, 34)}
{arrow(256, 98, 276, 98)}
{arrow(492, 98, 512, 98)}
"""
    return diagram(720, 140, inner, "A first session without an account: pick, place, move, check, export. Cloud is optional.")


CSS = f"""
:root {{
  --navy: {NAVY};
  --ink: {INK};
  --muted: {MUTED};
  --paper: {PAPER};
  --card: {CARD};
  --line: {LINE};
  --cyan: {CYAN};
  --orange: {ORANGE};
  --green: {GREEN};
  --red: {RED};
}}
* {{ box-sizing: border-box; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
@page {{
  size: A4;
  margin: 16mm 15mm 18mm 15mm;
}}
@page:first {{
  margin: 0;
}}
html, body {{
  margin: 0;
  padding: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, "Noto Sans", "Liberation Sans", sans-serif;
  font-size: 10.5pt;
  line-height: 1.45;
}}
h1, h2, h3, .display {{
  font-family: "Noto Sans Display", Inter, sans-serif;
  letter-spacing: -0.02em;
  line-height: 1.15;
}}
h1 {{ font-size: 28pt; margin: 0 0 8px; }}
h2 {{
  font-size: 16.5pt;
  margin: 0 0 10px;
  color: var(--navy);
  break-after: avoid;
}}
h3 {{
  font-size: 12pt;
  margin: 16px 0 6px;
  color: var(--navy);
  break-after: avoid;
}}
p {{ margin: 0 0 9px; }}
.lede {{ font-size: 12pt; color: var(--muted); max-width: 42em; }}
section {{
  break-inside: auto;
  margin: 0 0 18px;
}}
.page-break {{ break-before: page; }}
.keep {{ break-inside: avoid; }}
.cover {{
  width: 210mm;
  height: 297mm;
  background: {NAVY};
  color: {PAPER};
  padding: 28mm 22mm 20mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  break-after: page;
}}
.cover-kicker {{
  font-size: 10pt;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: {CYAN};
  font-weight: 650;
}}
.cover h1 {{
  font-size: 34pt;
  color: {PAPER};
  max-width: 12em;
  margin-top: 18px;
}}
.cover .lede {{ color: #b7c6c9; font-size: 13pt; }}
.cover-meta {{
  display: flex;
  justify-content: space-between;
  gap: 24px;
  border-top: 1px solid #234048;
  padding-top: 16px;
  color: #8aa0a6;
  font-size: 9.5pt;
}}
.studs {{
  position: absolute;
  inset: auto 18mm 90mm auto;
  opacity: 0.16;
}}
.cover {{ position: relative; overflow: hidden; }}
nav.toc ol {{
  columns: 2;
  gap: 28px;
  padding-left: 22px;
  margin: 8px 0 0;
}}
nav.toc li {{ margin: 0 0 5px; }}
nav.toc a {{ color: var(--ink); text-decoration: none; }}
.grid-2 {{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 18px;
}}
.card {{
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  break-inside: avoid;
}}
.card h3 {{ margin-top: 0; }}
.card p:last-child {{ margin-bottom: 0; }}
.callout {{
  background: #E8F6F7;
  border-left: 4px solid var(--cyan);
  padding: 10px 14px;
  border-radius: 0 8px 8px 0;
  break-inside: avoid;
  margin: 10px 0 12px;
}}
.callout.warn {{ background: #FFF6EA; border-left-color: var(--orange); }}
.callout.idea {{ background: #F1F8F2; border-left-color: var(--green); }}
.diagram {{
  margin: 10px 0 14px;
  break-inside: avoid;
}}
.diagram svg {{
  display: block;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  font-family: Inter, "Noto Sans", sans-serif;
}}
.caption {{
  font-size: 9pt;
  color: var(--muted);
  margin: 6px 4px 0;
  font-style: italic;
}}
table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5pt;
  margin: 8px 0 12px;
  break-inside: avoid;
}}
th, td {{
  text-align: left;
  padding: 7px 8px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}}
th {{
  font-size: 8pt;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 650;
}}
code, .mono {{
  font-family: "JetBrains Mono", "Cascadia Mono", monospace;
  font-size: 0.88em;
}}
.kicker {{
  font-size: 8.5pt;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--cyan);
  font-weight: 700;
  margin-bottom: 4px;
}}
ul.plain {{ margin: 6px 0 10px; padding-left: 18px; }}
ul.plain li {{ margin: 0 0 4px; }}
.footer-note {{
  font-size: 8.5pt;
  color: var(--muted);
  margin-top: 8px;
}}
.hero-row {{
  display: flex;
  gap: 18px;
  margin: 14px 0 6px;
}}
.stat {{
  flex: 1;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
}}
.stat b {{ display: block; font-size: 16pt; color: var(--navy); }}
.stat span {{ font-size: 8.5pt; color: var(--muted); }}
"""


def cover_svg() -> str:
    studs = []
    for row in range(5):
        for col in range(6):
            x = 18 + col * 34
            y = 18 + row * 34
            studs.append(
                f'<circle cx="{x}" cy="{y}" r="10" fill="none" stroke="#83e7ee" stroke-width="2"/>'
                f'<circle cx="{x}" cy="{y}" r="4" fill="#83e7ee"/>'
            )
    return f'<svg class="studs" width="220" height="190" viewBox="0 0 220 190" aria-hidden="true">{"".join(studs)}</svg>'


def html_doc() -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>How Brickwright works</title>
  <style>{CSS}</style>
</head>
<body>
  <div class="cover">
    {cover_svg()}
    <div>
      <div class="cover-kicker">Brickwright  ·  Visual guide</div>
      <h1>How this application actually works</h1>
      <p class="lede">A plain-language tour of the CAD kernel, the catalog, the 3D editor, the AI agent, saving, sharing, and the services that host it — with flowcharts for the paths a person can follow.</p>
    </div>
    <div class="cover-meta">
      <div>For humans who want the whole picture,<br/>not a file-by-file dump.</div>
      <div>Catalog build 2026-07<br/>One document · two operators · no guessing</div>
    </div>
  </div>

  <section>
    <div class="kicker">Contents</div>
    <h2>What is in this guide</h2>
    <nav class="toc">
      <ol>
        <li>The idea in one page</li>
        <li>A walk through the product</li>
        <li>Placing a brick</li>
        <li>The kernel and revisions</li>
        <li>The catalog of real parts</li>
        <li>How bricks clutch together</li>
        <li>Checking the model</li>
        <li>Building walls and buildings</li>
        <li>Saving locally and in the cloud</li>
        <li>Accounts (Hexclave)</li>
        <li>The AI assistant</li>
        <li>Generating from a sentence</li>
        <li>Refining a region</li>
        <li>Sharing a snapshot</li>
        <li>How production is wired</li>
        <li>Where the code lives</li>
      </ol>
    </nav>
  </section>

  <section class="page-break">
    <div class="kicker">01  ·  The idea</div>
    <h2>One model. Two operators. Nothing is a sketch.</h2>
    <p>Brickwright is a 3D CAD program for physically buildable brick models. It is not a chat window with a picture beside it. A person and an AI agent operate the <em>same</em> revisioned document, the same part catalog, the same snap solver, the same undo stack, and the same 3D view.</p>
    <p>If you remember only one sentence: <strong>the model document is the only source of truth</strong>. React, Three.js, chat transcripts, and cloud rows are derived views. If those views disagree with the document, the document wins and the views are rebuilt.</p>
    {d_big_idea()}
    <div class="hero-row keep">
      <div class="stat"><b>81,774</b><span>searchable part identities in catalog 2026-07</span></div>
      <div class="stat"><b>900</b><span>placeable parts with compiled geometry in this build</span></div>
      <div class="stat"><b>324,331</b><span>normalized connectors the snap solver can use</span></div>
    </div>
    <div class="callout idea keep">
      <p><strong>Why this matters.</strong> A language model is excellent at talking and terrible at secretly inventing a stud pitch. Brickwright lets it talk, then forces every brick through the same physics the mouse already uses. If a part cannot be placed, both of you get a teaching error rather than a fake brick.</p>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">02  ·  The product</div>
    <h2>What you can open, and what each page is allowed to load</h2>
    <p>The application is a single website with a few routes. The shell decides <em>how much CAD</em> a route may download before it paints. That is why the home page is a web page and the editor is a cockpit, not why two different apps were glued together.</p>
    {d_product_map()}
    <table>
      <thead><tr><th>Place</th><th>Who it is for</th><th>What is true there</th></tr></thead>
      <tbody>
        <tr><td><code>/</code> Landing</td><td>A visitor</td><td>Explains the product. Does not fetch the brick library.</td></tr>
        <tr><td><code>/explore</code></td><td>Someone browsing</td><td>Names real parts. Needs the catalog to say whether a part is real.</td></tr>
        <tr><td><code>/editor</code></td><td>A builder or an agent</td><td>The only surface that mutates a document.</td></tr>
        <tr><td><code>/projects</code></td><td>A signed-in person</td><td>Cloud and local projects. Needs an account.</td></tr>
        <tr><td><code>/share/…</code></td><td>Anyone with the link</td><td>A frozen, read-only publication. Cannot edit the original.</td></tr>
        <tr><td><code>/gallery</code></td><td>The public</td><td>Published models. Still no CAD kernel.</td></tr>
        <tr><td><code>/account</code></td><td>You</td><td>Sign-in, profile. Hexclave, not the CAD document.</td></tr>
      </tbody>
    </table>
    {d_boot()}
    {d_journey()}
  </section>

  <section class="page-break">
    <div class="kicker">03  ·  Everyday building</div>
    <h2>What happens when you put a brick down</h2>
    <p>From the chair, it feels like a game: pick a 2×4, hover, click. Underneath, the viewport is only supplying a ray — a line from the camera through the pixel you clicked. Everything after that is kernel work, so the ghost you see is the pose that will actually be committed.</p>
    {d_place_brick()}
    <div class="grid-2">
      <div class="card">
        <h3>The viewport is a picture</h3>
        <p>Three.js draws instanced meshes, a studio lighting environment, a transform gizmo, and red/green ghosts. None of that is stored. The scene graph can be thrown away and rebuilt from the document at any time.</p>
      </div>
      <div class="card">
        <h3>Coordinates are LDraw’s</h3>
        <p>Units are LDU. Y points down. One stud is 20 LDU; a plate is 8 LDU tall; a brick is 24. Orientation is a 3×3 matrix, not yaw/pitch/roll, so a mirrored piece round-trips into <code>.ldr</code> exactly.</p>
      </div>
      <div class="card">
        <h3>Useful keys</h3>
        <p><strong>R</strong> turns the held brick. <strong>M</strong> picks it up to reseat. <strong>G</strong> is the move gizmo. Shift-drag box-selects. ⌘Z / Ctrl+Z undoes the whole transaction, even if it placed a building.</p>
      </div>
      <div class="card">
        <h3>A brick on a tile is illegal</h3>
        <p>Resting on the ground without a mate is fine. Resting on another part without clutch is not — it would slide. The ghost turns red and tells you why. Enter respects the same rule as a click.</p>
      </div>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">04  ·  The kernel</div>
    <h2>Edits are transactions, not “the mesh moved”</h2>
    <p>UI code and agent tools both dispatch typed operations such as <code>part.add</code>, <code>part.transform</code>, <code>part.recolor</code>. A successful batch produces exactly one new revision and one undoable transaction. Connection edges are updated as part of that same transaction, so undo removes the clutch the edit created.</p>
    {d_revision()}
    <h3>Rules the kernel will not bend</h3>
    <ul class="plain">
      <li>The revision number only increases — including undo and redo.</li>
      <li>An agent mutation must name the exact revision it read.</li>
      <li>Protected parts and locked subassemblies cannot be silently rewritten.</li>
      <li>Only parts with compiled geometry can be placed. Catalog-only identities return <code>GEOMETRY_UNAVAILABLE</code>.</li>
      <li>Preflight (a ghost proposal) does not replace the live document.</li>
      <li>There is no fake catalog. If the compiled assets are missing, the editor refuses to start.</li>
    </ul>
    <div class="callout keep">
      <p><strong>Command deck parity.</strong> The same assembly generators a person finds under ASSEMBLE are the tools an agent calls. “The human UI can do it but the agent cannot” is treated as a bug, not a phase.</p>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">05  ·  The catalog</div>
    <h2>Three levels of knowing a part — and search says which one you got</h2>
    <p>The library is compiled offline from three independently licensed datasets. At runtime Brickwright does not scrape LEGO’s website and does not invent a mesh when it is missing.</p>
    {d_catalog()}
    <table>
      <thead><tr><th>Tier</th><th>What is known</th><th>What you can do</th></tr></thead>
      <tbody>
        <tr><td>Placeable</td><td>Mesh, envelope, LDCad connectors</td><td>Build, snap, collide, render, export</td></tr>
        <tr><td>Modelled</td><td>Official LDraw shape and connections; no mesh in this build</td><td>Inspect and search. Placing it is refused.</td></tr>
        <tr><td>Catalogued</td><td>Name, category, set appearances</td><td>Confirm it exists. The wider index is fetched only when you search past the modelled library.</td></tr>
      </tbody>
    </table>
    <p>Search is ranked, not filtered: an exact part number wins, then a name, then a measured size like <code>2x4</code>, then a buried word. Official-set frequency breaks ties. Asking the agent to place a search-only part teaches it to call search with <code>requireGeometry=true</code>.</p>
    <div class="callout warn keep">
      <p><strong>Licensing is not the code licence.</strong> Brickwright’s source is AGPL-3.0. The catalog bytes are derivatives of LDraw, LDCad, and Rebrickable, and those terms travel with the assets. Attribution is recorded in <code>licenses.json</code>.</p>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">06  ·  Clutch</div>
    <h2>How two bricks decide they are actually attached</h2>
    <p>Each placeable part carries connector frames compiled from the LDCad Shadow Library — studs, anti-studs, pins, holes, axles, clips, hinges, balls. A mate is not “close enough in space.” It is two frames brought into coincidence, with aligned axes, and a known leftover freedom (fixed, revolute, cylindrical, spherical, or honestly unknown).</p>
    {d_snap()}
    <div class="grid-2">
      <div class="card">
        <h3>Why the formula looks scary</h3>
        <p><code>Tm = Tt · Ft · C · Fm⁻¹</code> means: start from the target brick, walk to its connector, apply the joint’s leftover wiggle, then walk back out the moving brick’s connector. You get a full pose. Studs-not-on-top and right-angle Technic fall out of the same expression as ordinary stacking.</p>
      </div>
      <div class="card">
        <h3>The graph is saved</h3>
        <p>Each mated pair is stored with when it appeared and how it was made (snap, explicit Connect, or inferred on import). That graph is what “is this one piece or three?” and “can I sequence a build guide?” are computed from.</p>
      </div>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">07  ·  Checking</div>
    <h2>Collision, connectivity, and whether it stands up</h2>
    <p>A correct stack looks like an intersection in a naive model: the stud occupies the tube. So Brickwright does not shout “collision” at every legal clutch. It also does not pretend a bounding-box overlap is a proven crash.</p>
    {d_collision()}
    {d_validation()}
    <p>Mass and tipping come from the compiled surface volume, not from a made-up box. Two caveats are printed on every statics report rather than scaled away: computed mass runs a bit heavy because LDraw is an idealized solid, and clutch strength is an assumption (LEGO publishes none).</p>
  </section>

  <section class="page-break">
    <div class="kicker">08  ·  Building at scale</div>
    <h2>One instruction, a whole storey</h2>
    <p>Placing a wall brick-by-brick is where quality dies: stacked seams, unbonded corners, doors that are just holes. Parametric planners in the kernel do the bricklaying using measured part lengths from this catalog. They emit ordinary <code>part.add</code> operations, so undo, ghosts, protection, and collision still apply.</p>
    {d_assembly()}
    <div class="callout keep">
      <p><strong>An opening is not a hole.</strong> Where the pack has a window or door that fits, it is seated as a real element and it decides how many courses the opening spans. Courses above and below bridge the edges so a doorway does not become a perforated column you could pull off with your fingers.</p>
    </div>
    <p>You can capture a finished bay as a module and stamp it along a street, rotated about its own footprint. Four such instructions have been measured at over a thousand parts, thousands of mates, and zero collisions — still a handful of undo steps.</p>
  </section>

  <section class="page-break">
    <div class="kicker">09  ·  Memory</div>
    <h2>Your computer first. The cloud is a replica.</h2>
    <p>Every committed transaction is appended to an IndexedDB log on top of a periodic checkpoint. Reopening replays forward from the checkpoint. A gap in the log stops replay rather than applying history out of order. The save indicator tells you whether persistence is durable, memory-only, or failing.</p>
    {d_local_cloud()}
    <table>
      <thead><tr><th>Situation</th><th>What happens</th></tr></thead>
      <tbody>
        <tr><td>Signed out, or Hexclave not configured</td><td>Full CAD against local storage. Honest empty account chrome.</td></tr>
        <tr><td>Offline while signed in</td><td>Edits keep landing in IndexedDB and the outbox. Sync drains later.</td></tr>
        <tr><td>Two people edited from the same revision</td><td>The second write is <code>STALE_DOCUMENT</code>. Recovery can fork a conflict branch and keep both histories. No last-write-wins.</td></tr>
        <tr><td>Upload interrupted</td><td>Claims and forks are retry-safe. The same client transaction id is idempotent.</td></tr>
      </tbody>
    </table>
    <p>Cloud history is the same log: snapshots plus transactions, paged against a fixed revision, checksummed. A missing page is an error, not a quietly partial model.</p>
  </section>

  <section class="page-break">
    <div class="kicker">10  ·  Identity</div>
    <h2>Hexclave is who you are. Convex is what you share.</h2>
    <p>Brickwright uses Hexclave for users, authentication, email, and analytics. Password, one-time codes, passkeys, Google, and GitHub are enabled. The CAD kernel does not know your email. Cloud membership is keyed on the Hexclave user id inside the access token.</p>
    {d_identity()}
    <div class="grid-2">
      <div class="card">
        <h3>Invitations</h3>
        <p>Sharing a project with a person who is not a member yet sends mail through Hexclave. Delivery is retried with a visible status. Expired invites do not block a replacement. Email is an address to deliver to, never an authorisation key.</p>
      </div>
      <div class="card">
        <h3>Analytics are masked</h3>
        <p>Product analytics fire for shell events. CAD content — part numbers, prompts, model names that would leak a design — is masked so a session replay is not a free copy of the build.</p>
      </div>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">11  ·  The agent</div>
    <h2>A design partner that cannot sneak a brick in</h2>
    <p>You talk in ordinary language. The assistant reads the model through tools, plans in the same capability vocabulary as the command deck, and produces <strong>waves</strong> you review. The language model has no commit tool in any mode. The only path onto the command bus is the same accept function a person clicks.</p>
    {d_assistant()}
    {d_autonomy()}
    <p>In ChatGPT’s desktop browser the same tools register as Site Tools. In an ordinary browser they appear as <code>window.brickwright.invoke(…)</code>, which is how tests and developers exercise the identical surface.</p>
    <div class="callout warn keep">
      <p><strong>Secrets stay off the page.</strong> <code>ANTHROPIC_API_KEY</code> lives in the Node API process. The browser sends a grounded transcript to <code>POST /api/assistant</code> and receives an NDJSON stream. The server keeps no session: the transcript travels with the request. Timeouts and byte ceilings are enforced there so the page cannot raise them.</p>
    </div>
  </section>

  <section class="page-break">
    <div class="kicker">12  ·  Generation</div>
    <h2>From a sentence to bricks that actually clutch</h2>
    <p>Generation is for “build me a small red fire station,” not for nudging one plate. The important trick: a candidate is never a list of guessed world coordinates. It is a <strong>build graph</strong> of part/region intents joined by connector attachments. The deterministic realiser turns each attachment into a pose with the kernel’s own snap solver. Bulk walls and decks are delegated to the parametric planners.</p>
    {d_generation()}
    <p>Several candidates are produced from different structural strategies and seeds. If they are secretly the same building, the structural hash says so — you do not get three skins of one idea. Applying a candidate is one transaction at the current revision, or a refusal if the document moved.</p>
  </section>

  <section class="page-break">
    <div class="kicker">13  ·  Refinement</div>
    <h2>The design doctor</h2>
    <p>Refinement is the second half of the loop. Something rough exists. You select a region and say “make the roof lower and cleaner.” The module locates findings, generates alternatives (restack, simplify, reinforce, symmetrize, and friends), scores a full metric vector — regressions included — and hands back ranked ghosts that have already passed the kernel’s checks.</p>
    {d_refinement()}
    <p>Heavy work can run in a web worker so the viewport stays alive. A language model, if present, may only set weights and ordering. It still does not get to invent coordinates.</p>
  </section>

  <section class="page-break">
    <div class="kicker">14  ·  Publish</div>
    <h2>A share link is a photograph of a revision</h2>
    <p>Publishing captures the document at an exact revision, strips private notes and agent prompts, hashes the bytes, and freezes the object. A second write to the same slug is refused. Open Graph images are rendered from that snapshot at publish time, not fetched from a live GPU later.</p>
    {d_share()}
    <p>The public viewer is a different program path: it does not import the engine, the session, or the command bus. Forking copies the frozen model into <em>your</em> editor as a new document. Export still works where the publication allowed it — <code>.ldr</code>, MPD with submodels, BOM CSV, printable HTML build guides with embedded step pictures.</p>
  </section>

  <section class="page-break">
    <div class="kicker">15  ·  Production</div>
    <h2>Three services behind one hostname</h2>
    <p>Production is <code>https://brickwrite.tech</code>. You never talk to the model API’s public hostname; an edge proxy rate-limits paid paths and forwards with a shared secret. Unproxied calls to the Vercel origin answer <code>403</code> on purpose.</p>
    {d_deploy()}
    <table>
      <thead><tr><th>Service</th><th>Holds</th><th>If it is missing</th></tr></thead>
      <tbody>
        <tr><td>Cloudflare Pages</td><td>The app, catalog, share HTML, API proxy</td><td>The site is down.</td></tr>
        <tr><td>Vercel Node</td><td>Assistant and generation, model keys</td><td>CAD still works. Chat and generate fail honestly.</td></tr>
        <tr><td>Convex</td><td>Project replicas and collaboration</td><td>CAD still works locally. Cloud projects unavailable.</td></tr>
        <tr><td>Hexclave</td><td>Login, email, analytics</td><td>CAD still works. Accounts unavailable.</td></tr>
      </tbody>
    </table>
    <p>A production build made without the Hexclave project id or Convex URL is a supported mode: a working editor with no account layer. That is also why a misconfigured deploy can look “fine” until you try to sign in.</p>
  </section>

  <section class="page-break">
    <div class="kicker">16  ·  The repository</div>
    <h2>A map if you want to open the code</h2>
    <p>You do not need this section to use the product. It is here so the folders match the story above.</p>
    {d_code_map()}
    <h3>How a change is supposed to travel</h3>
    <ol>
      <li>If it changes what a brick <em>is</em>, it belongs in <code>src/cad</code> and must go through operations and revisions.</li>
      <li>If it changes how a brick <em>looks or is gripped</em>, it belongs in the editor, which dispatches those operations.</li>
      <li>If it is a new agent skill, it is a tool schema plus a kernel capability — never a private back door.</li>
      <li>If it is accounts, email, or analytics, it should use Hexclave rather than a one-off service.</li>
    </ol>
    <div class="callout idea keep">
      <p><strong>The test that captures the philosophy.</strong> A generated building is asserted to be bonded, collision-free, fully billed, sequenced into real steps, and undoable as the number of generator calls you made — not as a screenshot that “looks like a house.”</p>
    </div>
    <p class="footer-note">This guide describes the application as of catalog 2026-07. Numbers (part counts, coverage) are measurements of that committed build. The architecture — one document, two operators, a kernel that refuses to guess — is the part that is meant to stay true as those numbers grow.</p>
  </section>
</body>
</html>
"""


def print_pdf(html_path: Path, pdf_path: Path) -> None:
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "google-chrome",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        f"--print-to-pdf={pdf_path}",
        "--no-pdf-header-footer",
        "--virtual-time-budget=15000",
        html_path.resolve().as_uri(),
    ]
    print("Running:", " ".join(cmd), file=sys.stderr)
    subprocess.run(cmd, check=True)
    print(f"Wrote {pdf_path} ({pdf_path.stat().st_size} bytes)", file=sys.stderr)


def main() -> None:
    html_text = html_doc()
    OUT_HTML.write_text(html_text, encoding="utf-8")
    print(f"Wrote {OUT_HTML}", file=sys.stderr)
    print_pdf(OUT_HTML, OUT_PDF)


if __name__ == "__main__":
    main()
