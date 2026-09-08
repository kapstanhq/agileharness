---
id: story-chamado-historico
type: story
title: Ver o histórico do chamado
storyType: user
status: priorizar
parent: step-chamado
release: r2
personas:
- livreiro
systems:
- checkout
links: []
narrative:
  role: livreiro que opera a loja
  want: ver o histórico do chamado
  soThat: um problema vira uma conversa rastreável
acceptance:
- Dado que estou na loja, quando ver o histórico do chamado, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando ver o histórico do chamado, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
