---
id: story-obra-capa
type: story
title: Enviar a capa do livro
storyType: user
status: stage
parent: step-cadastrar-obra
release: r2
personas:
- livreiro
systems:
- contas
links: []
narrative:
  role: livreiro que opera a loja
  want: enviar a capa do livro
  soThat: coloco um título novo à venda em minutos
acceptance:
- Dado que estou na loja, quando enviar a capa do livro, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando enviar a capa do livro, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
