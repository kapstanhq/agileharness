// A FRONTEIRA server → client dos ÍCONES (um defeito real): a página /semana respondia 500 em produção
// com «Functions cannot be passed directly to Client Components». A view era um SERVER component (sem "use client")
// e passava `icon={CalendarDays}` ao `PageHeader`, que é client — um componente do lucide é uma FUNÇÃO, e função não
// atravessa a fronteira do RSC. O typecheck, o lint e a suíte inteira passavam: o erro só existe na serialização do
// Next em tempo de requisição. Esta trava pega a forma do defeito em qualquer arquivo: um .tsx SEM "use client" que
// importa um ícone do lucide-react e o passa COMO VALOR de prop (`={Icone}`), em vez de renderizá-lo (`<Icone />`).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...sources(full));
    } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(full);
  }
  return out;
}

/** O arquivo declara "use client" antes de qualquer código (comentários e linhas vazias podem vir antes). */
function isClient(text: string): boolean {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    return /^["']use client["'];?$/.test(line);
  }
  return false;
}

/** Os nomes locais importados de lucide-react (`import { A, B as C } from "lucide-react"`). */
function lucideNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const part of m[1].split(",")) {
      const local = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (local && !local.startsWith("type ")) names.push(local);
    }
  }
  return names;
}

describe("ícone do lucide não atravessa a fronteira server → client como valor", () => {
  it("nenhum server component passa um ícone do lucide-react como prop (`={Icone}`)", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      if (isClient(text)) continue;
      for (const name of lucideNames(text)) {
        const re = new RegExp(`=\\{\\s*${name}\\s*\\}`);
        text.split("\n").forEach((line, i) => {
          if (re.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a trava enxerga o defeito do incidente (server component com `icon={CalendarDays}`)", () => {
    const incident = `// view\nimport { CalendarDays } from "lucide-react";\nexport function V() { return <PageHeader icon={CalendarDays} />; }\n`;
    expect(isClient(incident)).toBe(false);
    expect(lucideNames(incident)).toEqual(["CalendarDays"]);
    expect(/=\{\s*CalendarDays\s*\}/.test(incident)).toBe(true);
    expect(isClient(`// comentário\n"use client";\nimport x from "y";`)).toBe(true);
  });
});
