"use client";

// 🪟 TABELA — o mesmo documento como uma grade varrível: uma linha por item.
//
// É a view mais barata do catálogo e a que melhor PROVA o desacoplamento: ela não sabe o que é um
// canvas, um card ou uma persona. Pergunta ao schema quais seções carregam itens e desenha. Qualquer
// documento que satisfaça o contrato (`itemBearingSections`) a ganha sem escrever uma linha.
//
// Ela existe porque o quadro responde "como isto se organiza?" e a tabela responde outra pergunta:
// "o que existe aqui, tudo de uma vez?" — comparar 40 itens espalhados por 9 cartões é exatamente o
// que uma grade faz melhor. Por isso é de LEITURA: quem edita tem o documento e a fonte, e uma
// terceira superfície de escrita só multiplicaria o jeito de errar.

import { cn } from "@/lib/cn";
import type { DocSchema } from "@/lib/storymap/doc/doc-schema";
import { sectionItems, type SchemaDoc } from "@/lib/storymap/doc/schema-codec";
import { itemBearingSections } from "@/lib/storymap/doc/view-contracts";
import { DOC } from "@/components/doc/typography";
import { docTags, splitItemText } from "./item-text";

export interface TableViewProps {
  doc: SchemaDoc;
  schema: DocSchema;
  className?: string;
}

export function TableView({ doc, schema, className }: TableViewProps) {
  const tags = docTags(doc.frontmatter);
  const sections = itemBearingSections(schema);

  const rows = sections.flatMap((rule) =>
    sectionItems(doc, rule.key).map((item, index) => {
      const split = splitItemText(item.text, tags);
      return { rule, index, group: item.group, checked: item.checked, ...split };
    }),
  );

  if (!rows.length) {
    return (
      <p className="rounded-lg border border-dashed border-line-emphasis/70 px-4 py-6 text-center text-[13px] text-fg-subtle">
        Ainda não há nada escrito neste documento.
      </p>
    );
  }

  // COLUNA VAZIA NÃO SE DESENHA. Grupo e etiqueta são opcionais no modelo, e num documento que não usa
  // nenhum dos dois as duas colunas ficavam ali reservando ~200px para mostrar nada — empurrando o
  // conteúdo (a única coluna que importa) para a direita e fazendo a grade parecer quebrada. Como a
  // decisão é por DADO e não por docType, ela se ajusta sozinha quando o autor começa a agrupar.
  const hasGroups = rows.some((r) => !!r.group);
  const hasTags = rows.some((r) => r.tags.length > 0);

  return (
    // A grade rola DENTRO do próprio contêiner — a página nunca rola na horizontal.
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <Th>Seção</Th>
            {hasGroups && <Th>Grupo</Th>}
            {hasTags && <Th>Etiqueta</Th>}
            <Th className="w-full">Conteúdo</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            // A primeira linha de cada seção é a única que repete o nome dela: uma coluna com o
            // mesmo texto 8 vezes seguidas é ruído, e o olho já lê o agrupamento pela borda.
            const first = i === 0 || rows[i - 1].rule.key !== row.rule.key;
            return (
              <tr
                key={`${row.rule.key}-${row.index}`}
                className={cn("align-top", first && i > 0 && "border-t border-line")}
              >
                <Td className="whitespace-nowrap">
                  {first && (
                    <span className="text-[12.5px] font-semibold text-fg-muted">{row.rule.label}</span>
                  )}
                </Td>
                {hasGroups && (
                  <Td className="whitespace-nowrap">
                    {row.group && <span className="text-[12.5px] text-fg-subtle">{row.group}</span>}
                  </Td>
                )}
                {hasTags && (
                  <Td className="whitespace-nowrap">
                    {row.tags.map((t) => (
                      <span
                        key={t.id}
                        className="mr-1 inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-muted"
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: t.color ?? "var(--fg-subtle)" }}
                        />
                        {t.name}
                      </span>
                    ))}
                  </Td>
                )}
                <Td>
                  <span
                    className={cn(
                      DOC.tableCell,
                      row.checked ? "text-fg-subtle line-through" : "text-fg",
                    )}
                  >
                    {row.text}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("px-3 py-2", DOC.tableHead, "text-fg-muted", className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2", className)}>{children}</td>;
}
