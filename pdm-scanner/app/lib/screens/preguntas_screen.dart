/// Pantalla de preguntas adaptativas.
///
/// Es el corazón de la propuesta: en vez de inventar la clave primaria, se
/// pregunta. Cada pregunta muestra su motivo, porque un usuario que sabe por
/// qué le preguntan responde mejor.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models.dart';
import '../state.dart';

class PreguntasScreen extends StatefulWidget {
  const PreguntasScreen({super.key});

  @override
  State<PreguntasScreen> createState() => _PreguntasScreenState();
}

class _PreguntasScreenState extends State<PreguntasScreen> {
  /// Respuestas acumuladas: id de pregunta -> valor elegido.
  final Map<String, String> _respuestas = {};
  final Map<String, TextEditingController> _campos = {};
  bool _enviando = false;

  @override
  void dispose() {
    for (final controlador in _campos.values) {
      controlador.dispose();
    }
    super.dispose();
  }

  TextEditingController _campo(String id) => _campos.putIfAbsent(
        id,
        () => TextEditingController(),
      );

  void _elegir(Pregunta pregunta, String valor) {
    setState(() => _respuestas[pregunta.id] = valor);
  }

  Future<void> _enviar() async {
    if (_respuestas.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Responde al menos una pregunta.')),
      );
      return;
    }

    setState(() => _enviando = true);
    final estado = context.read<EstadoApp>();

    final lista = <Map<String, dynamic>>[];
    for (final pregunta in estado.resultado?.questions ?? const <Pregunta>[]) {
      final valor = _respuestas[pregunta.id];
      if (valor == null || valor.trim().isEmpty) continue;

      switch (pregunta.kind) {
        case 'primary_key':
          lista.add({
            'question_id': pregunta.id,
            'value': valor,
            'apply': 'key',
            'target': pregunta.table,
          });
          break;
        case 'identity':
        case 'column_type':
        case 'nullability':
          lista.add({
            'question_id': pregunta.id,
            'value': valor,
            'apply': 'column',
            'target': pregunta.table,
            'column_ref': pregunta.column,
          });
          break;
        default:
          lista.add({
            'question_id': pregunta.id,
            'value': valor,
            'apply': 'table',
            'target': pregunta.table,
          });
      }
    }

    await estado.responder(lista);
    if (!mounted) return;
    setState(() => _enviando = false);

    if (estado.error != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(estado.error!)),
      );
      return;
    }
    // Si ya no queda nada por preguntar, se sale sola.
    if (estado.resultado!.questions.isEmpty) {
      Navigator.of(context).popUntil((ruta) => ruta.isFirst);
    } else {
      setState(_respuestas.clear);
    }
  }

  @override
  Widget build(BuildContext context) {
    final estado = context.watch<EstadoApp>();
    final preguntas = estado.resultado?.questions ?? const <Pregunta>[];

    return Scaffold(
      appBar: AppBar(title: Text('${preguntas.length} pregunta(s)')),
      body: preguntas.isEmpty
          ? const Center(child: Text('No falta nada. El modelo está completo.'))
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: preguntas.length,
              itemBuilder: (context, indice) => _TarjetaPregunta(
                pregunta: preguntas[indice],
                valor: _respuestas[preguntas[indice].id],
                controlador: _campo(preguntas[indice].id),
                onElegir: (v) => _elegir(preguntas[indice], v),
              ),
            ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _enviando ? null : _enviar,
        icon: _enviando
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.check),
        label: Text(_enviando ? 'Guardando...' : 'Guardar respuestas'),
      ),
    );
  }
}

class _TarjetaPregunta extends StatelessWidget {
  const _TarjetaPregunta({
    required this.pregunta,
    required this.valor,
    required this.controlador,
    required this.onElegir,
  });

  final Pregunta pregunta;
  final String? valor;
  final TextEditingController controlador;
  final void Function(String) onElegir;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(pregunta.question, style: Theme.of(context).textTheme.titleMedium),
            if (pregunta.reason.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                pregunta.reason,
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
              ),
            ],
            if (pregunta.options.isNotEmpty) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: pregunta.options.map((opcion) {
                  final seleccionada = valor == opcion;
                  return ChoiceChip(
                    label: Text(opcion),
                    selected: seleccionada,
                    onSelected: (_) => onElegir(opcion),
                  );
                }).toList(),
              ),
            ],
            const SizedBox(height: 12),
            // Campo libre siempre: las opciones son sugerencias, no una jaula.
            TextField(
              controller: controlador,
              decoration: InputDecoration(
                labelText: 'O escribe la respuesta',
                border: const OutlineInputBorder(),
                isDense: true,
                suffixIcon: IconButton(
                  icon: const Icon(Icons.check),
                  onPressed: () => onElegir(controlador.text),
                ),
              ),
              onSubmitted: onElegir,
            ),
          ],
        ),
      ),
    );
  }
}
