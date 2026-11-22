import type { PlayerId } from "@shared/gameEngine";
import { TRIBES } from "@/lib/tribes";

/**
 * Shared SVG gradients, rendered once per page so every totem / fire token can
 * reference them by id without duplicating <defs>.
 */
export function ArtDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <defs>
        {(Object.keys(TRIBES) as PlayerId[]).map((id) => {
          const t = TRIBES[id];
          return (
            <g key={id}>
              <linearGradient id={`tw-body-${id}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={t.light} />
                <stop offset="0.35" stopColor={t.base} />
                <stop offset="1" stopColor={t.dark} />
              </linearGradient>
              <linearGradient id={`tw-head-${id}`} x1="0" x2="0.3" y1="0" y2="1">
                <stop offset="0" stopColor={t.light} />
                <stop offset="1" stopColor={t.dark} />
              </linearGradient>
            </g>
          );
        })}
        <linearGradient id="tw-gold" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#fff1b8" />
          <stop offset="0.45" stopColor="#e7b850" />
          <stop offset="1" stopColor="#8a5f12" />
        </linearGradient>
        <radialGradient id="tw-ember" cx="0.5" cy="0.6" r="0.6">
          <stop offset="0" stopColor="#ffb347" />
          <stop offset="0.35" stopColor="#c2410c" />
          <stop offset="0.75" stopColor="#4a1205" />
          <stop offset="1" stopColor="#1f0802" />
        </radialGradient>
        <linearGradient id="tw-flame-outer" x1="0" x2="0" y1="1" y2="0">
          <stop offset="0" stopColor="#dc2626" />
          <stop offset="0.6" stopColor="#f97316" />
          <stop offset="1" stopColor="#fbbf24" />
        </linearGradient>
        <linearGradient id="tw-flame-inner" x1="0" x2="0" y1="1" y2="0">
          <stop offset="0" stopColor="#fb923c" />
          <stop offset="1" stopColor="#fef3c7" />
        </linearGradient>
        <linearGradient id="tw-stone" x1="0" x2="1">
          <stop offset="0" stopColor="#78716c" />
          <stop offset="0.4" stopColor="#57534e" />
          <stop offset="1" stopColor="#292524" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Tribe-specific headdress drawn above the carved totem face. */
function Headdress({ tribe }: { tribe: PlayerId }) {
  const fill = `url(#tw-head-${tribe})`;
  const stroke = "rgba(0,0,0,0.45)";
  switch (tribe) {
    case "P1": // Aztec: radiating sun-feather fan
      return (
        <g stroke={stroke} strokeWidth="1.2">
          {[-60, -30, 0, 30, 60].map((deg) => (
            <path key={deg} d="M50 34 L44 10 Q50 2 56 10 Z" fill={fill} transform={`rotate(${deg} 50 34)`} />
          ))}
          <circle cx="50" cy="31" r="5" fill="url(#tw-gold)" />
        </g>
      );
    case "P2": // Maya: stepped-pyramid crown
      return (
        <g stroke={stroke} strokeWidth="1.2">
          <path d="M28 34 V27 H34 V21 H41 V15 H59 V21 H66 V27 H72 V34 Z" fill={fill} />
          <rect x="46" y="9" width="8" height="6" fill="url(#tw-gold)" />
        </g>
      );
    case "P3": // Eagle: spread wings
      return (
        <g stroke={stroke} strokeWidth="1.2">
          <path d="M33 40 Q16 30 8 14 Q20 20 26 18 Q24 26 34 31 Z" fill={fill} />
          <path d="M67 40 Q84 30 92 14 Q80 20 74 18 Q76 26 66 31 Z" fill={fill} />
          <path d="M36 34 Q50 14 64 34 Z" fill={fill} />
        </g>
      );
    case "P4": // Big Bear: round ears + brow
      return (
        <g stroke={stroke} strokeWidth="1.2">
          <circle cx="34" cy="26" r="8" fill={fill} />
          <circle cx="66" cy="26" r="8" fill={fill} />
          <circle cx="34" cy="26" r="3.5" fill="rgba(0,0,0,0.35)" />
          <circle cx="66" cy="26" r="3.5" fill="rgba(0,0,0,0.35)" />
          <path d="M30 36 Q50 22 70 36 Z" fill={fill} />
        </g>
      );
  }
}

/** Tribe-specific face details carved into the top block. */
function Face({ tribe }: { tribe: PlayerId }) {
  const carve = "rgba(0,0,0,0.55)";
  return (
    <g>
      <rect x="38" y="42" width="8" height="5" rx="1" fill={carve} />
      <rect x="54" y="42" width="8" height="5" rx="1" fill={carve} />
      <rect x="40" y="43" width="3" height="2" fill="#fde68a" />
      <rect x="56" y="43" width="3" height="2" fill="#fde68a" />
      {tribe === "P3" ? (
        <path d="M46 48 L54 48 L50 57 Z" fill="url(#tw-gold)" stroke={carve} strokeWidth="1" />
      ) : tribe === "P4" ? (
        <ellipse cx="50" cy="53" rx="6" ry="4" fill={carve} />
      ) : (
        <rect x="42" y="51" width="16" height="4" rx="1" fill={carve} />
      )}
    </g>
  );
}

/** 3D-styled carved totem for a tribe. */
export function Totem({ tribe, className = "" }: { tribe: PlayerId; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <ellipse cx="50" cy="92" rx="26" ry="5" fill="rgba(0,0,0,0.45)" />
      {/* stone pedestal */}
      <path d="M28 84 H72 L68 92 H32 Z" fill="url(#tw-stone)" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
      {/* carved pole */}
      <rect x="31" y="36" width="38" height="50" rx="6" fill={`url(#tw-body-${tribe})`} stroke="rgba(0,0,0,0.5)" strokeWidth="1.2" />
      {/* carved bands */}
      <rect x="31" y="60" width="38" height="4" fill="rgba(0,0,0,0.3)" />
      <rect x="31" y="61" width="38" height="1" fill="url(#tw-gold)" opacity="0.8" />
      <path d="M36 70 L42 76 L48 70 L54 76 L60 70 L64 74" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="2" />
      {/* side wings / arms of the pole */}
      <path d="M31 66 L22 70 L31 74 Z" fill={`url(#tw-head-${tribe})`} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
      <path d="M69 66 L78 70 L69 74 Z" fill={`url(#tw-head-${tribe})`} stroke="rgba(0,0,0,0.4)" strokeWidth="1" />
      <Face tribe={tribe} />
      <Headdress tribe={tribe} />
      {/* specular highlight for the 3D look */}
      <rect x="35" y="38" width="4" height="44" rx="2" fill="rgba(255,255,255,0.22)" />
    </svg>
  );
}

/** Gold-rimmed ember token with an animated flame. */
export function FireToken({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <circle cx="50" cy="52" r="44" fill="rgba(0,0,0,0.45)" />
      <circle cx="50" cy="50" r="43" fill="url(#tw-ember)" stroke="url(#tw-gold)" strokeWidth="6" />
      <circle cx="50" cy="50" r="36" fill="none" stroke="rgba(254,243,199,0.35)" strokeWidth="1" strokeDasharray="3 4" />
      <circle className="ember-glow" cx="50" cy="62" r="20" fill="#f97316" opacity="0.6" style={{ filter: "blur(6px)" }} />
      <path className="flame" d="M50 18 C62 34 72 44 68 62 C65 74 35 74 32 62 C28 46 42 38 50 18 Z" fill="url(#tw-flame-outer)" />
      <path className="flame flame-mid" d="M50 34 C58 44 63 52 60 63 C57 71 43 71 40 63 C38 54 45 46 50 34 Z" fill="url(#tw-flame-inner)" />
      <path className="flame flame-core" d="M50 48 C54 54 56 58 54 64 C52 68 48 68 46 64 C44 58 47 54 50 48 Z" fill="#fffbeb" opacity="0.9" />
    </svg>
  );
}

/** Decorative torch for the board frame. */
export function Torch({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 100" className={className} aria-hidden="true">
      <circle className="ember-glow" cx="20" cy="22" r="16" fill="#f97316" opacity="0.5" style={{ filter: "blur(7px)" }} />
      <path className="flame" d="M20 4 C28 14 31 22 28 32 C26 38 14 38 12 32 C9 22 14 16 20 4 Z" fill="url(#tw-flame-outer)" />
      <path className="flame flame-mid" d="M20 14 C24 20 26 25 24 31 C22 35 18 35 16 31 C14 25 17 20 20 14 Z" fill="url(#tw-flame-inner)" />
      <path d="M11 36 H29 L26 46 H14 Z" fill="url(#tw-gold)" stroke="rgba(0,0,0,0.5)" />
      <rect x="17" y="46" width="6" height="50" rx="2" fill="#5b3a1e" stroke="rgba(0,0,0,0.5)" />
      <rect x="16" y="58" width="8" height="3" fill="url(#tw-gold)" />
      <rect x="16" y="76" width="8" height="3" fill="url(#tw-gold)" />
    </svg>
  );
}

/** Decorative spear for the board frame (points right). */
export function Spear({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 20" className={className} aria-hidden="true" preserveAspectRatio="none">
      <rect x="0" y="8.5" width="168" height="3" fill="#6b4423" />
      <rect x="40" y="7" width="6" height="6" fill="url(#tw-gold)" />
      <rect x="120" y="7" width="6" height="6" fill="url(#tw-gold)" />
      <path d="M8 10 L0 4 L4 10 L0 16 Z" fill="#b91c1c" />
      <path d="M166 3 L198 10 L166 17 L172 10 Z" fill="#d6d3d1" stroke="#57534e" />
    </svg>
  );
}

/** Small fiery arrowhead glyph used to mark valid arrow targets. */
export function ArrowGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <path d="M20 4 L30 22 L23 20 L23 36 L17 36 L17 20 L10 22 Z" fill="url(#tw-flame-outer)" stroke="#7c2d12" strokeWidth="1.5" />
    </svg>
  );
}
