import { useId, type JSX } from 'react';

/**
 * What Gwyn is doing. Every mood starts with him climbing up through the
 * portal and taking hold of its rim (the brand's "arrive" pose into "peek"):
 * - `loading` then glances side to side with his antenna light pulsing.
 * - `wave` then waves, for an empty chat.
 * - `peek` then just blinks now and then, for a quiet empty state.
 */
export type GwynMood = 'loading' | 'wave' | 'peek';

/**
 * Gwyn, the Otherworld mascot, drawn from the brand's Gwyn poses (Brand/Gwyn/gwyn-*.svg).
 * The brand sheet keeps him off product icons and puts him in empty states,
 * About boxes and loading screens, which is where this goes. He is
 * decoration: the caller says what's happening in text, so the drawing is
 * hidden from screen readers. The animations are the `gwyn-*` classes in
 * index.css, and with reduced motion he holds still in the peek pose.
 */
export function Gwyn({ mood, className = '' }: { mood: GwynMood; className?: string }): JSX.Element {
  // Two Gwyns on screen (two panes) mustn't share gradient and clip ids.
  const id = useId().replace(/:/g, '');
  const body = `gwyn-body-${id}`;
  const clip = `gwyn-clip-${id}`;
  return (
    <svg
      viewBox="-135 -140 270 280"
      aria-hidden="true"
      data-testid="gwyn"
      data-mood={mood}
      className={`gwyn gwyn-${mood} ${className}`}
    >
      <defs>
        <radialGradient id={body} cx="0.4" cy="0.28" r="1.0">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.62" stopColor="#F2EFE6" />
          <stop offset="1" stopColor="#CFD8D2" />
        </radialGradient>
        <clipPath id={clip}>
          <ellipse rx="99" ry="117" />
        </clipPath>
      </defs>
      {/* The portal and the stars beyond it. */}
      <ellipse rx="104" ry="122" fill="#0A1118" />
      <circle cx="-30" cy="-64" r="2.4" fill="#33465C" />
      <circle cx="34" cy="-30" r="1.8" fill="#33465C" />
      <circle cx="-12" cy="-8" r="1.5" fill="#33465C" />
      {/* Gwyn himself, clipped to the portal so he rises out of it. */}
      <g clipPath={`url(#${clip})`}>
        <g className="gwyn-rise">
          <g className="gwyn-antenna">
            <path d="M 2 16 Q -2 -22 -30 -32" fill="none" stroke="#F2EFE6" strokeWidth="6" strokeLinecap="round" />
            <circle className="gwyn-bulb-glow" cx="-34" cy="-34" r="13" fill="#5EEAD4" opacity="0.28" />
            <circle cx="-34" cy="-34" r="9" fill="#5EEAD4" />
          </g>
          <circle cx="4" cy="102" r="88" fill={`url(#${body})`} />
          <g className="gwyn-eyes">
            <ellipse cx="-18" cy="52" rx="11" ry="15.5" fill="#0A1118" />
            <ellipse cx="28" cy="52" rx="11" ry="15.5" fill="#0A1118" />
            <circle cx="-14.3" cy="46" r="3.7" fill="#fff" />
            <circle cx="31.7" cy="46" r="3.7" fill="#fff" />
          </g>
          <path d="M -2 76 Q 5 83 12 76" fill="none" stroke="#0A1118" strokeWidth="5.2" strokeLinecap="round" />
        </g>
      </g>
      {/* The portal ring. */}
      <ellipse rx="104" ry="122" fill="none" stroke="#5EEAD4" strokeWidth="24" opacity="0.16" />
      <ellipse rx="104" ry="122" fill="none" stroke="#5EEAD4" strokeWidth="10" />
      {/* His hands on the rim: the left always, the right gripping it or waving. */}
      <g className="gwyn-hands">
        <ellipse cx="-58" cy="96" rx="16.5" ry="12.5" transform="rotate(30 -58 96)" fill="#F2EFE6" stroke="#0A1118" strokeWidth="2.5" />
        {mood === 'wave' ? (
          <g className="gwyn-wave-hand">
            <ellipse cx="88" cy="34" rx="17.5" ry="13.5" transform="rotate(-58 88 34)" fill="#F2EFE6" stroke="#0A1118" strokeWidth="2.5" />
            <path d="M 106 16 q 8 -6 10 -14" fill="none" stroke="#5EEAD4" strokeWidth="3.5" strokeLinecap="round" />
            <path d="M 112 34 q 10 -2 16 -8" fill="none" stroke="#5EEAD4" strokeWidth="3.5" strokeLinecap="round" />
          </g>
        ) : (
          <ellipse cx="66" cy="90" rx="16.5" ry="12.5" transform="rotate(-32 66 90)" fill="#F2EFE6" stroke="#0A1118" strokeWidth="2.5" />
        )}
      </g>
    </svg>
  );
}
