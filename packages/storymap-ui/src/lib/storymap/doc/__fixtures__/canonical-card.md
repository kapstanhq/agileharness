## Contexto

O assistente conversa pelo WhatsApp e pela web. Hoje a descoberta depende de o usuário pedir explicitamente; queremos que boas recomendações apareçam de forma natural no fluxo da conversa.

## Escopo In/Out

Decisões registradas nas perguntas [q1](#q1) e [q2](#q2).

**Dentro:**

- Reagrupar a agenda por dia (mesmo padrão do feed principal).
- Esconder da agenda os eventos que já ocorreram.
- Restaurar a seção própria para filmes salvos (fecha a regressão vs. `story-perfil-agenda`).

**Fora:**

- Extrair `EventRow` para um componente em `packages/<shared>` — mudança maior, exige autorização à parte.

---

## Critérios de aceite

- [x] A recomendação aparece na conversa sem o usuário pedir listagem.
- [ ] Cada item traz imagem própria e um motivo curto ("porque você curtiu…").
- [ ] Salvar um item pela conversa reflete na agenda em até 1 dia.

<details><summary>Decisões e trade-offs (q1, q2)</summary>

**q1 — Premissa de classificação:** filmes salvos formam seção própria; a regressão vs. `story-perfil-agenda` fica fechada.

**q2 — Sem shared:** restilizar o componente existente em vez de extrair para `packages/<shared>`.

</details>

## Métricas de aceite

| Métrica | Alvo | Atual |
| --- | --- | --- |
| Salvam ≥1 evento na 1ª sessão | ≥ 40% | 31% |
| Recomendações abertas por sessão | ≥ 3 | 2.4 |

> "Eu queria só saber o que fazer hoje à noite — não abrir seis apps pra decidir."

## Prompt de referência

```text system-prompt · recs
Você é o assistente. Ao recomendar, use o gosto aprendido do usuário.
Máx. 3 por resposta. Sem botões de reply.
```

![mockup — card de evento no feed](docs/mockup-card.png)
