# Code Memory Visualizer

Etapa 1 do projeto: uma extensao do VS Code para executar codigo Python passo a passo e mostrar a linha atual em um painel interno.

## O que esta etapa entrega

- Comando `Code Memory: Start`.
- Painel webview dentro do VS Code.
- Leitura do arquivo Python ativo ou selecao de um arquivo `.py`.
- Execucao Python com pausa na proxima linha rastreada.
- Controles basicos:
  - Executar
  - Proxima etapa
  - Reiniciar
- Destaque visual da linha atualmente executada.
- Adaptador `PythonAdapter`, deixando a interface separada da execucao da linguagem.

Nesta etapa ainda nao ha visualizacao detalhada de variaveis, stack, heap ou referencias.

## Como testar no VS Code

1. Abra esta pasta no VS Code.
2. Pressione `F5` para iniciar uma janela de desenvolvimento da extensao.
3. Na nova janela, abra `examples/sample.py` ou outro arquivo Python.
4. Execute o comando `Code Memory: Start` pela paleta de comandos.
5. Use `Executar`, `Proxima etapa` e `Reiniciar` no painel.

## Teste de fumaca

O projeto tem um teste simples do runner Python:

```bash
npm test
```

Ele executa `examples/sample.py` por meio de `src/python/traceRunner.py` e verifica se eventos de pausa e termino sao emitidos.

Se o Python nao estiver no `PATH`, informe o executavel:

```bash
CODE_MEMORY_PYTHON=/path/to/python npm test
```

## Configuracao

A extensao usa `python` por padrao. Se necessario, ajuste `codeMemory.pythonPath` nas configuracoes do VS Code.

Exemplos:

```json
{
  "codeMemory.pythonPath": "python"
}
```

```json
{
  "codeMemory.pythonPath": "py -3"
}
```

## Arquitetura inicial

```text
VS Code command
  -> MemoryVisualizerPanel
  -> LanguageAdapter
  -> PythonAdapter
  -> traceRunner.py
```

A camada visual recebe eventos comuns, como `paused`, `output`, `done` e `error`. O adaptador Python transforma a execucao real do Python nesses eventos.

## Proxima etapa

A Etapa 2 deve adicionar o modelo `ExecutionState` e a visualizacao de variaveis atualizadas a cada passo.
