## Contexto

Quem monta um pedido com títulos de sebos diferentes paga uma remessa por sebo, e o total só aparece no último passo do fechamento. O frete combinado precisa estar visível já no carrinho.

## Dentro e fora do escopo

As escolhas vêm das perguntas [q1](#q1) e [q2](#q2).

**Entra:**

- Somar o frete por sebo e mostrar a economia ao lado do total (na mesma linha do cupom).
- Esconder o aviso quando todos os livros saem do mesmo sebo.
- Manter o prazo de cada remessa à vista (corrige o sumiço em `story-prazo-entrega`).

**Não entra:**

- Mover `ShippingRow` para `packages/<shared>` — refatoração maior, pede decisão separada.

---

## Critérios de aceite

- [x] O carrinho exibe o frete combinado antes do leitor chegar ao pagamento.
- [ ] Cada remessa informa o sebo de origem e um prazo curto ("chega em 3 dias úteis").
- [ ] Trocar um livro de sebo refaz o total em menos de 1 segundo.

<details><summary>Escolhas e custos (q1, q2)</summary>

**q1 — Arredondamento:** o combinado arredonda para cima, centavo a centavo; o prazo volta a aparecer e `story-prazo-entrega` deixa de regredir.

**q2 — Sem shared:** ajustar a linha de frete existente em vez de movê-la para `packages/<shared>`.

</details>

## Métricas de aceite

| Métrica | Alvo | Atual |
| --- | --- | --- |
| Pedidos com 2+ sebos que concluem | ≥ 60% | 48% |
| Remessas por pedido | ≤ 1.5 | 1.9 |

> "Paguei dois fretes e só descobri no último botão."

## Instrução do atendente

```text system-prompt · frete
Você atende pela livraria. Ao explicar o frete, cite o sebo de cada remessa.
Máx. 2 frases por remessa. Nada de emojis.
```

![mockup — carrinho com frete combinado](docs/mockup-carrinho.png)
