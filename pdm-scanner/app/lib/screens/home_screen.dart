/// Pantalla principal: conexión al servidor, captura y estado del escaneo.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

// Las rutas de un import relativo son relativas a ESTE fichero, no a la raíz
// del proyecto: desde lib/screens/ los módulos de lib/ van con '../'.
import '../models.dart';
import '../state.dart';
import 'preguntas_screen.dart';
import 'revision_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _controlIp = TextEditingController();
  final _picker = ImagePicker();
  bool _preparado = false;

  @override
  void initState() {
    super.initState();
    _arrancar();
  }

  Future<void> _arrancar() async {
    final estado = context.read<EstadoApp>();
    await estado.cargarServidorGuardado();
    _controlIp.text = estado.base;
    _preparado = true;
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controlIp.dispose();
    super.dispose();
  }

  Future<void> _conectar() async {
    final estado = context.read<EstadoApp>();
    await estado.conectar(_controlIp.text.trim());
  }

  /// Foto nueva o de la galería. La de galería está porque a veces es más
  /// cómodo hacer una captura con un escáner deSobremesa ya connected.
  Future<void> _capturar(ImageSource origen) async {
    final estado = context.read<EstadoApp>();
    if (!estado.conectado) {
      _avisar('Primero conéctate al servidor.');
      return;
    }
    try {
      final foto = await _picker.pickImage(
        source: origen,
        // Bajar la resolución acelera el OCR y no se pierde nada legible en un
        // diagrama: el texto de una tabla es grande.
        maxWidth: 2400,
        imageQuality: 90,
      );
      if (foto == null) return;
      await estado.escanear(File(foto.path));
      if (!mounted) return;
      _trasEscanear(estado);
    } catch (e) {
      _avisar('No se ha podido abrir la cámara: $e');
    }
  }

  void _trasEscanear(EstadoApp estado) {
    if (estado.error != null) {
      _avisar(estado.error!);
      estado.limpiarError();
      return;
    }
    if (estado.resultado == null) return;
    if (estado.resultado!.questions.isNotEmpty) {
      Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const PreguntasScreen()),
      );
    }
  }

  void _avisar(String mensaje) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(mensaje), duration: const Duration(seconds: 6)),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_preparado) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Consumer<EstadoApp>(
      builder: (context, estado, _) => Scaffold(
        appBar: AppBar(
          title: const Text('PDM Scanner'),
          actions: [
            IconButton(
              tooltip: 'Conectar a otro servidor',
              icon: const Icon(Icons.dns_outlined),
              onPressed: estado.conectado ? _conectar : null,
            ),
          ],
        ),
        body: estado.conectado ? _cuerpoConectado(estado) : _cuerpoConfiguracion(estado),
      ),
    );
  }

  // -- Configuración del servidor ----------------------------------------

  Widget _cuerpoConfiguracion(EstadoApp estado) {
    final cargando = estado.fase == Fase.configurando;

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.qr_code_scanner, size: 64),
              const SizedBox(height: 12),
              Text(
                'Conecta con el servidor de tu PC',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 8),
              const Text(
                'Todo el procesamiento ocurre en tu ordenador. '
                'El móvil solo hace la foto y te muestra las preguntas.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _controlIp,
                decoration: const InputDecoration(
                  labelText: 'Dirección del servidor',
                  hintText: 'http://192.168.1.40:8000',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.wifi),
                ),
                keyboardType: TextInputType.url,
                autocorrect: false,
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: cargando ? null : _conectar,
                icon: cargando
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.link),
                label: Text(cargando ? 'Conectando...' : 'Conectar'),
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
              ),
              if (estado.error != null) ...[
                const SizedBox(height: 16),
                _TarjetaAviso(icono: Icons.error_outline, texto: estado.error!, rojo: true),
              ],
              const SizedBox(height: 24),
              const Text(
                '¿No sabes la IP? En el PC, con el servidor arrancado, '
                'ejecuta "ipconfig" y busca la línea "Dirección IPv4".',
                style: TextStyle(fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // -- Pantalla de trabajo -----------------------------------------------

  Widget _cuerpoConectado(EstadoApp estado) {
    if (estado.fase == Fase.escaneando) {
      return const _Escaneando();
    }

    final resultado = estado.resultado;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _TarjetaEstado(estado: estado),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: () => _capturar(ImageSource.camera),
                icon: const Icon(Icons.photo_camera),
                label: const Text('Hacer foto'),
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _capturar(ImageSource.gallery),
                icon: const Icon(Icons.photo_library_outlined),
                label: const Text('De la galería'),
                style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
              ),
            ),
          ],
        ),
        if (resultado != null && resultado.warnings.isNotEmpty) ...[
          const SizedBox(height: 16),
          for (final aviso in resultado.warnings)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _TarjetaAviso(icono: Icons.info_outline, texto: aviso),
            ),
        ],
        const SizedBox(height: 16),
        if (resultado != null) _TarjetaProgreso(resultado: resultado),
        const SizedBox(height: 16),
        if (resultado != null && resultado.questions.isNotEmpty)
          FilledButton.tonalIcon(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const PreguntasScreen()),
            ),
            icon: const Icon(Icons.help_outline),
            label: Text('Responder ${resultado.questions.length} pregunta(s)'),
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
          ),
        if (resultado != null) ...[
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const RevisionScreen()),
            ),
            icon: const Icon(Icons.schema_outlined),
            label: const Text('Ver el modelo'),
            style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
          ),
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: estado.exportarPdm,
            icon: const Icon(Icons.download),
            label: const Text('Generar .pdm'),
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
          ),
        ],
        if (estado.rutaPdm != null) ...[
          const SizedBox(height: 8),
          _TarjetaAviso(icono: Icons.check_circle_outline, texto: 'Guardado en:\n${estado.rutaPdm}'),
        ],
      ],
    );
  }
}

class _Escaneando extends StatelessWidget {
  const _Escaneando();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 24),
            Text('Leyendo el diagrama…', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            const Text(
              'La primera vez puede tardar un minuto: el modelo de lenguaje '
              'se carga en memoria. Las siguientes van mucho más rápido.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}

class _TarjetaEstado extends StatelessWidget {
  const _TarjetaEstado({required this.estado});

  final EstadoApp estado;

  @override
  Widget build(BuildContext context) {
    final servidor = estado.estado;
    if (servidor == null) return const SizedBox.shrink();

    final faltaAlgo = !servidor.operativo;

    return Card(
      color: faltaAlgo ? Colors.orange.withValues(alpha: 0.12) : null,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  faltaAlgo ? Icons.warning_amber_rounded : Icons.check_circle_outline,
                  color: faltaAlgo ? Colors.orange : Colors.green,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    faltaAlgo ? 'El servidor necesita algo' : 'Servidor listo',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _Fila(ok: servidor.ocrDisponible, etiqueta: 'OCR', valor: servidor.ocrMotores.isEmpty
                ? servidor.ocrDetalle
                : servidor.ocrMotores.join(', ')),
            const SizedBox(height: 6),
            _Fila(
              ok: servidor.llmDisponible,
              etiqueta: 'LLM local',
              valor: servidor.llmDisponible
                  ? servidor.llmModelo
                  : (servidor.llmModelos.isEmpty ? servidor.llmDetalle : servidor.llmDetalle),
            ),
            if (faltaAlgo) ...[
              const SizedBox(height: 12),
              const Text(
                'Instálalo en el PC y reinicia el servidor. La app no puede escanear '
                'sin los dos.',
                style: TextStyle(fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Fila extends StatelessWidget {
  const _Fila({required this.ok, required this.etiqueta, required this.valor});

  final bool ok;
  final String etiqueta;
  final String valor;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(ok ? Icons.check : Icons.close, size: 16, color: ok ? Colors.green : Colors.red),
        const SizedBox(width: 8),
        Text('$etiqueta: ', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
        Expanded(
          child: Text(
            valor,
            style: const TextStyle(fontSize: 12),
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

class _TarjetaProgreso extends StatelessWidget {
  const _TarjetaProgreso({required this.resultado});

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
            Text(resultado.modelo.name, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              '${stats['tablas'] ?? 0} tablas · ${stats['columnas'] ?? 0} columnas · '
              '${stats['claves_foraneas'] ?? 0} FK',
              style: const TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: (resultado.completion / 100).clamp(0.0, 1.0),
                minHeight: 10,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '${resultado.completion.toStringAsFixed(0)}% confirmado · '
              'leído con ${resultado.ocrEngine} en ${resultado.elapsedSeconds.toStringAsFixed(1)}s',
              style: const TextStyle(fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

class _TarjetaAviso extends StatelessWidget {
  const _TarjetaAviso({required this.icono, required this.texto, this.rojo = false});

  final IconData icono;
  final String texto;
  final bool rojo;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: rojo ? Colors.red.withValues(alpha: 0.1) : Colors.blueGrey.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icono, size: 18, color: rojo ? Colors.red : Colors.blueGrey),
          const SizedBox(width: 8),
          Expanded(child: Text(texto, style: const TextStyle(fontSize: 12))),
        ],
      ),
    );
  }
}
