export function Room() {
  return (
    <svg
      viewBox="0 0 640 600"
      role="img"
      aria-label="A calm, sunlit living room with a green sofa and house plants"
      className="room-art"
    >
      <defs>
        <linearGradient id="wall" x2="1" y2="1">
          <stop stopColor="#f0e9da" />
          <stop offset="1" stopColor="#e4dbc9" />
        </linearGradient>
        <linearGradient id="sofa" x2="0" y2="1">
          <stop stopColor="#668770" />
          <stop offset="1" stopColor="#3d6554" />
        </linearGradient>
        <linearGradient id="light" x2="1" y2="1">
          <stop stopColor="#fff8da" stopOpacity=".8" />
          <stop offset="1" stopColor="#fff8da" stopOpacity="0" />
        </linearGradient>
        <filter id="shadow">
          <feDropShadow dx="0" dy="13" stdDeviation="12" floodColor="#293b2b" floodOpacity=".15" />
        </filter>
      </defs>
      <rect width="640" height="600" rx="120" fill="url(#wall)" />
      <path d="M0 420H640V600H0Z" fill="#d1bea0" />
      <path
        d="m0 480 640-8M0 530l640-13M70 600l120-180m70 180 35-180m160 180-70-180"
        stroke="#b3a18a"
        strokeWidth="2"
        opacity=".35"
      />
      <path d="M324 0h248v309H324z" fill="#d6cebc" />
      <path d="M338 0h219v295H338z" fill="#bfd1bc" />
      <path d="M338 260q35-90 80-115t139-38v188H338" fill="#a2b6a1" />
      <path d="M338 80h219m-110-80v295" stroke="#f9f4e7" strokeWidth="10" />
      <path d="m338 294 219 0 83 274-380-52Z" fill="url(#light)" />
      <path d="M310 0h31l-4 307h-44q28-131 17-307M552 0h32q-12 171 24 307h-47Z" fill="#faf4e7" />
      <rect x="89" y="92" width="119" height="151" rx="3" fill="#99795a" />
      <rect x="98" y="101" width="101" height="133" fill="#f6efdf" />
      <path d="M112 208q9-95 71-55v55Z" fill="#a2b598" />
      <circle cx="163" cy="133" r="14" fill="#c7a770" />
      <ellipse cx="326" cy="511" rx="238" ry="57" fill="#e9ddc4" />
      <ellipse cx="326" cy="511" rx="211" ry="45" fill="none" stroke="#c9b898" strokeWidth="3" />
      <g filter="url(#shadow)">
        <path d="m123 437-4 39m335-39 6 39" stroke="#624c3e" strokeWidth="12" />
        <rect x="112" y="296" width="348" height="146" rx="27" fill="url(#sofa)" />
        <rect x="126" y="304" width="158" height="99" rx="23" fill="#6a8b74" />
        <rect x="291" y="304" width="153" height="99" rx="23" fill="#6a8b74" />
        <rect x="118" y="390" width="335" height="62" rx="17" fill="#5f806b" />
        <path d="M284 393v54" stroke="#4b6d59" strokeWidth="2" />
        <rect x="97" y="365" width="44" height="88" rx="17" fill="#4e715b" />
        <rect x="432" y="365" width="44" height="88" rx="17" fill="#4e715b" />
        <rect
          x="150"
          y="331"
          width="72"
          height="72"
          rx="12"
          fill="#dfc897"
          transform="rotate(-12 185 366)"
        />
        <path d="m161 334 32 67m-13-71 30 64" stroke="#c0a571" strokeWidth="3" />
        <rect
          x="346"
          y="328"
          width="69"
          height="71"
          rx="12"
          fill="#e5e2ca"
          transform="rotate(13 380 365)"
        />
        <path d="M337 399q4 55 3 69h54q-13-35-8-69" fill="#d7c09d" />
        <path d="m349 407 2 61m12-61 3 61m12-61 4 61" stroke="#bba381" strokeWidth="2" />
      </g>
      <g>
        <path
          d="M535 422V212m0 106-41-47m42 4 38-45m-39 134 36-46"
          stroke="#526b45"
          strokeWidth="5"
        />
        <ellipse cx="520" cy="228" rx="17" ry="37" fill="#55784d" transform="rotate(-32 520 228)" />
        <ellipse cx="491" cy="267" rx="17" ry="32" fill="#7b9460" transform="rotate(-49 491 267)" />
        <ellipse cx="572" cy="233" rx="16" ry="34" fill="#708957" transform="rotate(35 572 233)" />
        <ellipse cx="570" cy="319" rx="17" ry="34" fill="#4c7049" transform="rotate(39 570 319)" />
        <path d="M507 405h59l-7 62h-45Z" fill="#b07c57" />
        <ellipse cx="537" cy="405" rx="30" ry="7" fill="#78583c" />
      </g>
      <g filter="url(#shadow)">
        <path d="m287 492-11 50m125-50 13 50" stroke="#8f6747" strokeWidth="9" />
        <ellipse cx="343" cy="489" rx="88" ry="26" fill="#b48b60" />
        <ellipse cx="343" cy="484" rx="88" ry="25" fill="#d6b083" />
        <rect x="307" y="467" width="48" height="8" rx="2" fill="#eee5ca" />
        <path d="M309 466h46v-6h-46Z" fill="#496a57" />
        <path d="M366 451h20v24h-20Z" fill="#f6eed9" />
        <path d="M386 455q14 0 8 12h-8" fill="none" stroke="#f6eed9" strokeWidth="4" />
      </g>
      <path d="m238 134 4 11 11 4-11 4-4 11-4-11-11-4 11-4Z" fill="#fffdf1" />
      <path d="m481 358 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#fffdf1" />
    </svg>
  );
}
