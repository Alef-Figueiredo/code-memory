# Code Memory Visualizer

Etapa 4 do projeto: uma extensao do VS Code para visualizacao didatica da execucao e memoria de programas, inspirada no Python Tutor, com suporte a Python e Java e arquitetura preparada para outras linguagens.

## O que esta etapa entrega

- Comando `Code Memory: Start`.
- Painel webview dentro do VS Code.
- Leitura do arquivo Python ou Java ativo, ou selecao manual de um arquivo `.py` ou `.java`.
- Arquitetura baseada em adaptadores de linguagem:
  - `LanguageAdapter`
  - `PythonAdapter`
  - `JavaAdapter`
- Modelo comum `ExecutionState`, usado pela interface independentemente da linguagem:
  - `currentLine`
  - `variables`
  - `callStack`
  - `stackFrames`
  - `heapObjects`
  - `references`
- Execucao passo a passo para Python.
- Execucao passo a passo para Java usando JDI, a API de debugging do JDK.
- Suporte a breakpoints em Java definidos no proprio VS Code.
- Visualizacao de stack frames, parametros e variaveis locais.
- Visualizacao de heap objects, campos, itens e referencias.
- Indicacao visual quando variaveis, objetos, frames e referencias aparecem ou mudam.
- Historico visual dos estados ja capturados, permitindo voltar e avancar por snapshots anteriores.
- Controle `Continuar`, que deixa a execucao seguir ate terminar ou ate o proximo breakpoint aplicavel.

## Como testar no VS Code

1. Abra esta pasta no VS Code.
2. Pressione `F5` para iniciar uma janela de desenvolvimento da extensao.
3. Na nova janela, abra `examples/sample.py` ou `examples/Sample.java`.
4. Para Java, adicione breakpoints no arquivo se quiser testar a execucao ate um ponto especifico.
5. Execute o comando `Code Memory: Start` pela paleta de comandos.
6. Use `Executar`, `Continuar`, `Proxima etapa`, `Voltar etapa` e `Reiniciar` no painel.
7. Observe as secoes `Stack`, `Heap`, `Referencias`, `Variaveis` e `Saida`.

## Testes de fumaca

O projeto tem dois testes simples: um para o runner Python e outro para o runner Java/JDI.

```bash
npm test
```

Ou rode separadamente:

```bash
node scripts/smoke-test.js
node scripts/java-smoke-test.js
```

Se o Python nao estiver no `PATH`, informe o executavel:

```bash
CODE_MEMORY_PYTHON=/path/to/python node scripts/smoke-test.js
```

No PowerShell:

```powershell
$env:CODE_MEMORY_PYTHON="C:\path\to\python.exe"
node scripts\smoke-test.js
```

## Requisitos para Java

O suporte a Java precisa de um JDK instalado, nao apenas de um JRE. O JDK deve disponibilizar:

- `javac`
- `java`
- modulo `jdk.jdi`

A extensao compila o arquivo Java selecionado com simbolos de debug e inicia o programa por JDI para capturar pausas, stack frames, variaveis, objetos e referencias.

## Configuracao

A extensao usa estes comandos por padrao:

```json
{
  "codeMemory.pythonPath": "python",
  "codeMemory.javaPath": "java",
  "codeMemory.javacPath": "javac"
}
```

Se necessario, ajuste os caminhos nas configuracoes do VS Code.

Exemplo com Python Launcher no Windows:

```json
{
  "codeMemory.pythonPath": "py -3"
}
```

Exemplo com JDK em caminho especifico:

```json
{
  "codeMemory.javaPath": "C:\\Program Files\\Java\\jdk-21\\bin\\java.exe",
  "codeMemory.javacPath": "C:\\Program Files\\Java\\jdk-21\\bin\\javac.exe"
}
```

## Arquitetura

```text
VS Code command
  -> MemoryVisualizerPanel
  -> LanguageAdapter
       -> PythonAdapter
       -> JavaAdapter
```

A camada visual recebe eventos comuns, como `paused`, `output`, `done` e `error`. Cada adaptador transforma a execucao real da linguagem no mesmo formato didatico de estado.

```text
ExecutionState
  currentLine
  variables
  callStack
  stackFrames
  heapObjects
  references
```

### Python

```text
PythonAdapter
  -> traceRunner.py
  -> sys.settrace
  -> ExecutionState
```

O runner Python usa `sys.settrace` para pausar por linha e coletar variaveis, frames, objetos Python e referencias visiveis.

### Java

```text
JavaAdapter
  -> JavaTraceRunner.java
  -> javac + JDI
  -> ExecutionState
```

O adaptador Java coleta breakpoints do VS Code, compila o runner de debugging e inicia `JavaTraceRunner`. O runner compila o arquivo `.java` selecionado, abre uma VM depurada por JDI, instala breakpoints e step requests, e converte valores locais, objetos e campos para o modelo comum da webview.

## Limitacoes atuais

- A visualizacao de heap e didatica, nao uma representacao byte a byte da memoria real do CPython ou da JVM.
- Valores muito grandes sao resumidos para manter o painel legivel.
- O runner Java foi pensado para arquivos `.java` pequenos e didaticos, com uma classe principal inferida a partir do nome do arquivo e do `package` declarado.
- Projetos Java com classpath externo, Maven, Gradle ou multiplos modulos ainda exigiriam uma etapa futura de integracao.
- Voltar etapa navega pelo historico visual ja capturado; ele nao desfaz a execucao real do programa.

## Estado do projeto

As quatro etapas solicitadas estao implementadas de forma cumulativa. Um proximo ciclo natural seria empacotar a extensao, melhorar suporte a projetos Java maiores ou adicionar novos adaptadores de linguagem sobre o mesmo contrato `LanguageAdapter`.