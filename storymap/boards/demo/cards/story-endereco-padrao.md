---
id: story-endereco-padrao
type: story
title: Definir o endereço padrão
storyType: user
status: plano-tecnico
parent: step-enderecos
release: r2
personas:
- leitor
systems:
- entrega
links: []
narrative:
  role: leitora que compra livros na loja
  want: definir o endereço padrão
  soThat: compro sem redigitar o endereço toda vez
acceptance:
- Dado que estou na loja, quando definir o endereço padrão, então a loja confirma a ação na própria tela.
- Dado que a operação falha, quando definir o endereço padrão, então vejo o motivo e o que fazer a seguir.
tasks: []
order: 20
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
