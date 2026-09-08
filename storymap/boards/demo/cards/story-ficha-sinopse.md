---
id: story-ficha-sinopse
type: story
title: Ler a sinopse e a ficha técnica
storyType: user
status: revisar-codigo
parent: step-ficha
release: r2
personas:
- leitor
systems:
- busca
links: []
narrative:
  role: leitora que compra livros na loja
  want: ler a sinopse e a ficha técnica
  soThat: decido pela sinopse, pela edição e pelo número de páginas
acceptance:
- Dado que estou na loja, quando ler a sinopse e a ficha técnica, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando ler a sinopse e a ficha técnica, então vejo o motivo e o que fazer
  a seguir.
tasks:
- id: t1
  title: Desenhar a tela e o estado vazio
  done: true
- id: t2
  title: Ligar a tela ao serviço
  done: false
- id: t3
  title: Cobrir com teste de aceite
  done: false
order: 10
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
