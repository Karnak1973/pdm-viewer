/// Revisión del modelo: qué se ha detectado y cuánto hay confirmado.
///
/// El color es la información: verde = confirmado por el usuario, ámbar = deducido
/// por el LLM. Es lo que permite saber de un vistazo si un `.pdm` es fiable.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models.dart';
import '../state.dart';

class RevisionScreen extends StatelessWidget {
  const RevisionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final estado = context.watch<EstadoApp>();
    final modelo = estado.modelo;

    return Scaffold(
      appBar: AppBar(title: const Text('Modelo detectado')),
      body: modelo.tables.isEmpty
          ? const Center(child: Text('Todavía no hay tablas. Haz una foto.'))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _Resumen(modelo: modelo, resultado: estado.resultado!),
                const SizedBox(height: 16),
                for (final tabla in modelo.tables) _TarjetaTabla(tabla: tabla),
                if (modelo.foreignKeys.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text('Claves foráneas', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 8),
                  for (final fk in modelo.foreignKeys) _TarjetaFk(fk: fk),
                ],
              ],
            ),
    );
  }
}

class _Resumen extends StatelessWidget {
  const _Resumen({required this.modelo, required this.resultado});

  final Modelo modelo;
  final ResultadoScan resultado;

  @override
  Widget build(BuildContext context) {
    final stats = resultado.stats;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(modelo.name, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Wrap(
              spacing: 16,
              runSpacing: 8,
              children: [
                _Dato('Tablas', '${stats['tablas'] ?? 0}'),
                _Dato('Columnas', '${stats['columnas'] ?? 0}'),
                _Dato('PK', '${stats['claves_primarias'] ?? 0}'),
                _Dato('FK', '${stats['claves_foraneas'] ?? 0}'),
                _Dato('Índices', '${stats['indices'] ?? 0}'),
              ],
            ),
            const SizedBox(height: 16),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: (resultado.completion / 100).clamp(0.0, 1.0),
                minHeight: 10,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              resultado.blockingQuestions > 0
                  ? 'Faltan ${resultado.blockingQuestions} dato(s) imprescindible(s) para un .pdm válido.'
                  : '${resultado.completion.toStringAsFixed(0)}% confirmado.',
              style: TextStyle(
                fontSize: 13,
                color: resultado.blockingQuestions > 0 ? Colors.orange : Colors.green,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Dato extends StatelessWidget {
  const _Dato(this.etiqueta, this.valor);

  final String etiqueta;
  final String valor;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(valor, style: Theme.of(context).textTheme.titleLarge),
        Text(etiqueta, style: const TextStyle(fontSize: 12)),
      ],
    );
  }
}

class _TarjetaTabla extends StatelessWidget {
  const _TarjetaTabla({required this.tabla});

  final Tabla tabla;

  @override
  Widget build(BuildContext context) {
    final pk = tabla.primaryKey;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: ExpansionTile(
        title: Text(tabla.name, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Text(
          pk == null
              ? 'SIN clave primaria'
              : 'PK (${pk.columns.join(', ')})',
          style: TextStyle(
            fontSize: 12,
            color: pk == null
                ? Colors.red
                : (pk.confidence == 'confirmed' ? Colors.green : Colors.orange),
          ),
        ),
        children: [
          for (final columna in tabla.columns)
            ListTile(
              dense: true,
              leading: Icon(
                _iconoDe(columna, pk),
                size: 18,
                color: columna.confirmado ? Colors.green : Colors.orange,
              ),
              title: Text('${columna.name}  ·  ${columna.tipoCompleto}'),
              subtitle: Text(
                '${columna.nulabilidad}${columna.identity ? ' · IDENTITY' : ''}',
                style: const TextStyle(fontSize: 11),
              ),
            ),
          if (tabla.indexes.isNotEmpty) ...[
            const Divider(),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: Text(
                'Índices: ${tabla.indexes.map((i) => '${i.name} (${i.columns.join(', ')})').join(' · ')}',
                style: const TextStyle(fontSize: 11),
              ),
            ),
          ],
        ],
      ),
    );
  }

  IconData _iconoDe(Columna columna, Clave? pk) {
    if (pk != null && pk.columns.contains(columna.code)) return Icons.key;
    if (columna.identity) return Icons.tag;
    return Icons.circle_outlined;
  }
}

class _TarjetaFk extends StatelessWidget {
  const _TarjetaFk({required this.fk});

  final ClaveForanea fk;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        dense: true,
        leading: Icon(
          Icons.link,
          color: fk.confidence == 'confirmed' ? Colors.green : Colors.orange,
        ),
        title: Text(fk.descripcion, style: const TextStyle(fontSize: 13)),
        subtitle: Text(
          '${fk.name}${fk.onDelete != null ? ' · ON DELETE ${fk.onDelete}' : ''}',
          style: const TextStyle(fontSize: 11),
        ),
      ),
    );
  }
}
