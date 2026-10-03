---
id: story-frete-endereco
type: story
title: Escolher entre os meus endereços
storyType: user
status: revisar-codigo
parent: step-frete
release: r2
personas:
- leitor
systems:
- busca
links: []
narrative:
  role: leitora que compra livros na loja
  want: escolher entre os meus endereços
  soThat: escolho entre preço e prazo com a informação na mão
acceptance:
- Dado que estou na loja, quando escolher entre os meus endereços, então a loja confirma a ação na própria
  tela.
- Dado que a operação falha, quando escolher entre os meus endereços, então vejo o motivo e o que fazer
  a seguir.
tasks: []
order: 30
created: '2026-08-01'
updated: '2026-08-01'
---

História de usuário do board de demonstração. Dado sintético: serve para exercitar o pipeline, não descreve um produto real.
