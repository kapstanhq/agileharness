---
id: story-comparar-custo-total
type: story
title: Ver o custo total com frete
storyType: user
status: arquivados
parent: step-comparar
release: r2
personas:
- livreiro
systems:
- entrega
links:
- rel: depends-on
  to: story-frete-opcoes
narrative:
  role: livreiro que opera a loja
  want: ver o custo total com frete
  soThat: escolho entre edições e formatos sabendo o custo total
acceptance:
- Dado que estou na loja, quando ver o custo total com frete, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando ver o custo total com frete, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
