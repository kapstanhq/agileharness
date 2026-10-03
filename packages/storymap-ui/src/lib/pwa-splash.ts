// Os aparelhos que ganham TELA DE ABERTURA no PWA do iOS.
//
// Esta lista tem DOIS consumidores e por isso mora sozinha aqui: o `app/layout.tsx` a transforma em
// `<link rel="apple-touch-startup-image" media="...">`, e o `scripts/gen-splash.ts` a transforma em
// arquivo PNG. Enquanto ela era um `const` privado do layout, o gerador precisaria de uma CÓPIA — e
// duas listas de aparelhos divergem no primeiro iPhone novo: o `<link>` aponta para um arquivo que
// ninguém gerou e a estreia do app vira uma tela preta. Uma lista, dois usos, nenhuma cópia.
//
// O iOS casa o `<link>` pelo tamanho em px CSS **e** pelo `-webkit-device-pixel-ratio` — daí os
// quatro números por aparelho. `w`/`h` são os device pixels (o nome do arquivo e o tamanho real do
// PNG); `cw`/`ch` são os px CSS; `r` é a densidade. Fora desta lista o iOS cai no `background_color`
// do manifest, que é o mesmo `#191919` — degrada para um retângulo da cor certa, nunca para branco.

export interface SplashDevice {
  /** largura em DEVICE pixels — o tamanho real do PNG e o sufixo do nome do arquivo. */
  readonly w: number;
  /** altura em DEVICE pixels. */
  readonly h: number;
  /** largura em px CSS (o que a media query casa). */
  readonly cw: number;
  /** altura em px CSS. */
  readonly ch: number;
  /** densidade (`-webkit-device-pixel-ratio`). */
  readonly r: number;
}

export const APPLE_SPLASH: readonly SplashDevice[] = [
  { w: 1320, h: 2868, cw: 440, ch: 956, r: 3 }, // iPhone 16 Pro Max
  { w: 1290, h: 2796, cw: 430, ch: 932, r: 3 }, // 15/16 Pro Max
  { w: 1206, h: 2622, cw: 402, ch: 874, r: 3 }, // 16 Pro
  { w: 1179, h: 2556, cw: 393, ch: 852, r: 3 }, // 14 Pro / 15
  { w: 1170, h: 2532, cw: 390, ch: 844, r: 3 }, // 12/13/14
  { w: 1125, h: 2436, cw: 375, ch: 812, r: 3 }, // X / XS / 11 Pro
  { w: 1242, h: 2688, cw: 414, ch: 896, r: 3 }, // XS Max / 11 Pro Max
  { w: 828, h: 1792, cw: 414, ch: 896, r: 2 }, // XR / 11
  { w: 750, h: 1334, cw: 375, ch: 667, r: 2 }, // SE / 8
  { w: 2048, h: 2732, cw: 1024, ch: 1366, r: 2 }, // iPad Pro 12.9"
  { w: 1668, h: 2388, cw: 834, ch: 1194, r: 2 }, // iPad Pro 11"
  { w: 1640, h: 2360, cw: 820, ch: 1180, r: 2 }, // iPad Air
  { w: 1536, h: 2048, cw: 768, ch: 1024, r: 2 }, // iPad
];

/** O caminho público do PNG de um aparelho — a MESMA conta no `<link>` e no gerador. */
export function splashHref({ w, h }: SplashDevice): string {
  return `/splash/apple-splash-${w}x${h}.png`;
}

/** A media query que o iOS usa para escolher a tela (retrato; paisagem cai no background_color). */
export function splashMedia({ cw, ch, r }: SplashDevice): string {
  return `(device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`;
}
