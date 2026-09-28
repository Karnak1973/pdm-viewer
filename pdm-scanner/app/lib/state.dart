/// Estado de la aplicación.
///
/// Un único `ChangeNotifier`: es una app de un usuario y un modelo a la vez,
/// así que un gestor de estado más potente sería complicar sin ganar nada.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';

enum Fase { configurando, listo, escaneando, revisando, fallando }

class EstadoApp extends ChangeNotifier {
  EstadoApp();

  static const _claveServidor = 'servidor_base';

  String base = 'http://192.168.1.100:8000';
  int modelId = 1;
  ClientePdm? _cliente;

  Fase fase = Fase.configurando;
  String? error;
  EstadoServidor? estado;
  ResultadoScan? resultado;
  String? rutaPdm;

  ClientePdm get cliente => _cliente ??= ClientePdm(base: base);
  bool get conectado => fase != Fase.configurando && fase != Fase.fallando;
  Modelo get modelo => resultado?.modelo ?? Modelo(name: 'Sin modelo');

  Future<void> cargarServidorGuardado() async {
    final preferencias = await SharedPreferences.getInstance();
    final guardado = preferencias.getString(_claveServidor);
    if (guardado != null && guardado.isNotEmpty) {
      base = guardado;
      notifyListeners();
    }
  }

  /// Comprueba la conexión y, si el servidor tiene un modelo, lo carga.
  Future<void> conectar(String nuevaBase) async {
    base = nuevaBase.endsWith('/')
        ? nuevaBase.substring(0, nuevaBase.length - 1)
        : nuevaBase;
    _cliente = null;
    fase = Fase.configurando;
    error = null;
    notifyListeners();

    final preferencias = await SharedPreferences.getInstance();
    await preferencias.setString(_claveServidor, base);

    try {
      estado = await cliente.health();
      modelId = await cliente.crearModelo('Modelo escaneado');
      resultado = await cliente.obtenerModelo(modelId);
      fase = Fase.listo;
    } on ErrorServidor catch (e) {
      error = e.mensaje;
      fase = Fase.fallando;
    } catch (e) {
      error = 'No se ha podido conectar: $e';
      fase = Fase.fallando;
    }
    notifyListeners();
  }

  /// Envía la foto. Es la operación lenta: de ahí el aviso de "puede tardar".
  Future<void> escanear(File foto) async {
    fase = Fase.escaneando;
    error = null;
    notifyListeners();

    try {
      resultado = await cliente.escanear(modelId, foto);
      rutaPdm = null;
      // Si el modelo ya no tiene preguntas, se va directo a la revisión.
      fase = resultado!.questions.isEmpty ? Fase.revisando : Fase.listo;
    } on ErrorServidor catch (e) {
      error = e.mensaje;
      fase = Fase.listo;
    } catch (e) {
      error = 'El escaneo ha fallado: $e';
      fase = Fase.listo;
    }
    notifyListeners();
  }

  /// Manda las respuestas y guarda el resultado.
  Future<void> responder(List<Map<String, dynamic>> respuestas) async {
    try {
      resultado = await cliente.responder(modelId, respuestas);
      error = null;
    } on ErrorServidor catch (e) {
      error = e.mensaje;
    } catch (e) {
      error = 'No se han podido guardar las respuestas: $e';
    }
    notifyListeners();
  }

  Future<void> refrescar() async {
    try {
      resultado = await cliente.obtenerModelo(modelId);
    } catch (_) {
      // Un refresco fallido no cambia la pantalla: el usuario ya ve datos.
    }
    notifyListeners();
  }

  /// Descarga el .pdm a Descargas/Documentos, que es donde el usuario lo
  /// buscará después para abrirlo en PowerDesigner.
  Future<void> exportarPdm() async {
    try {
      final directorio = Directory('${Directory.systemTemp.path}/pdm-scanner');
      if (!directorio.existsSync()) {
        directorio.createSync(recursive: true);
      }
      final nombre = modelo.name.replaceAll(' ', '_');
      final fichero = await cliente.descargarPdm(modelId, '${directorio.path}/$nombre.pdm');
      rutaPdm = fichero.path;
      error = null;
    } on ErrorServidor catch (e) {
      error = e.mensaje;
    } catch (e) {
      error = 'No se ha podido exportar: $e';
    }
    notifyListeners();
  }

  void limpiarError() {
    error = null;
    notifyListeners();
  }
}
