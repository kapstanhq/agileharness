---
id: story-busca-por-autor
type: story
title: Buscar pelo autor
storyType: user
status: priorizar
parent: step-buscar
release: r2
personas:
- leitor
systems:
- checkout
links: []
narrative:
  role: leitora que compra livros na loja
  want: buscar pelo autor
  soThat: chego ao livro certo sem navegar por menus
acceptance:
- Dado que estou na loja, quando buscar pelo autor, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando buscar pelo autor, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
