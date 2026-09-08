---
id: story-obra-importar
type: story
title: Importar uma planilha de títulos
storyType: user
status: merge
parent: step-cadastrar-obra
release: r1
personas:
- livreiro
systems:
- entrega
links: []
narrative:
  role: livreiro que opera a loja
  want: importar uma planilha de títulos
  soThat: coloco um título novo à venda em minutos
acceptance:
- Dado que estou na loja, quando importar uma planilha de títulos, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando importar uma planilha de títulos, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
