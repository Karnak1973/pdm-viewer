/// Cliente HTTP del servidor local.
///
/// Regla del proyecto: nada sale del PC del usuario. Esta clase solo se
/// conecta a la IP de la red local que el usuario escribe, y falla con un
/// mensaje accionable en vez de un error de red críptico.
library;

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Error con mensaje pensado para enseñarse tal cual en pantalla.
class ErrorServidor implements Exception {
  ErrorServidor(this.mensaje);

  final String mensaje;

  @override
  String toString() => mensaje;
}

class ClientePdm {
  ClientePdm({required this.base});

  /// p. ej. `http://192.168.1.40:8000`. Sin barra final.
  final String base;

  static const Duration _timeoutLargo = Duration(minutes: 5);

  Uri _uri(String path) => Uri.parse('$base$path');

  Future<Map<String, String>> _cabecerasJson() async => {
        'Content-Type': 'application/json; charset=utf-8',
      };

  /// Traduce los errores típicos de red a algo que el usuario pueda arreglar.
  Never _traducir(Object error) {
    if (error is SocketException) {
      throw ErrorServidor(
        'No se puede contactar con el servidor en $base.\n\n'
        'Comprueba que:\n'
        '1. El servidor está arrancado (uvicorn app.main:app --host 0.0.0.0).\n'
        '2. El móvil y el PC están en la misma wifi.\n'
        '3. La IP es correcta: en el PC, ejecuta "ipconfig" y mira la IPv4.',
      );
    }
    if (error is HttpException) {
      throw ErrorServidor('Error de red: ${error.message}');
    }
    if (error is FormatException) {
      throw ErrorServidor('La respuesta del servidor no se ha podido leer.');
    }
    throw ErrorServidor('Error inesperado: $error');
  }

  Future<EstadoServidor> health() async {
    try {
      final respuesta = await http.get(_uri('/health')).timeout(const Duration(seconds: 8));
      if (respuesta.statusCode != 200) {
        return EstadoServidor.desconectado();
      }
      return EstadoServidor.desdeJson(
        jsonDecode(utf8.decode(respuesta.bodyBytes)) as Map<String, dynamic>,
      );
    } catch (error) {
      if (error is ErrorServidor) rethrow;
      _traducir(error);
    }
  }

  Future<int> crearModelo(String nombre) async {
    try {
      final respuesta = await http.post(
        _uri('/models'),
        headers: await _cabecerasJson(),
        body: jsonEncode({'nombre': nombre}),
      );
      final cuerpo = jsonDecode(utf8.decode(respuesta.bodyBytes)) as Map<String, dynamic>;
      return cuerpo['id'] as int? ?? 1;
    } catch (error) {
      if (error is ErrorServidor) rethrow;
      _traducir(error);
    }
  }

  Future<ResultadoScan> obtenerModelo(int modelId) async {
    try {
      final respuesta = await http.get(_uri('/models/$modelId'));
      return _scan(respuesta);
    } catch (error) {
      if (error is ErrorServidor) rethrow;
      _traducir(error);
    }
  }

  /// Sube la foto. Tarda lo que tarde el LLM, de ahí el timeout largo.
  Future<ResultadoScan> escanear(
    int modelId,
    File foto, {
    String motorOcr = 'auto',
    bool aplicarAutomatico = true,
  }) async {
    try {
      final peticion = http.MultipartRequest('POST', _uri('/models/$modelId/scan'))
        ..fields['motor_ocr'] = motorOcr
        ..fields['aplicar_automatico'] = aplicarAutomatico.toString()
        ..files.add(await http.MultipartFile.fromPath('foto', foto.path));

      final streamed = await peticion.send().timeout(_timeoutLargo);
      final respuesta = await http.Response.fromStream(streamed);

      if (respuesta.statusCode != 200) {
        throw ErrorServidor(_detalleDe(respuesta));
      }
      return _scan(respuesta);
    } on TimeoutException {
      throw ErrorServidor(
        'El escaneo ha tardado más de 5 minutos.\n\n'
        'Es normal la primera vez: el modelo se carga en memoria la primera vez. '
        'Si sigue igual, prueba con un modelo más pequeño (qwen2.5-coder:3b).',
      );
    } catch (error) {
      if (error is ErrorServidor) rethrow;
      _traducir(error);
    }
  }

  /// Envía las respuestas. El servidor marca lo confirmado como intocable.
  Future<ResultadoScan> responder(int modelId, List<Map<String, dynamic>> respuestas) async {
    try {
      final respuesta = await http.post(
        _uri('/models/$modelId/answers'),
        headers: await _cabecerasJson(),
        body: jsonEncode(respuestas),
      );
      if (respuesta.statusCode != 200) {
        throw ErrorServidor(_detalleDe(respuesta));
      }
      return _scan(respuesta);
    } catch (error) {
      if (error is ErrorServidor) rethrow;
      _traducir(error);
    }
  }

  /// Descarga el .pdm a un fichero local y devuelve su ruta.
  Future<File> descargarPdm(int modelId, String destino) async {
    try {
      final respuesta = await http.get(_uri('/models/$modelId/export.pdm')).timeout(
        const Duration(seconds: 60),
      );
      if (respuesta.statusCode != 200) {
        throw ErrorServidor(_detalleDe(respuesta));
      }
      final fichero = File(destino);
      await fichero.writeAsBytes(respuesta.bodyBytes);
      return fichero;
    } catch (error) {
      if (error is ErrorServidor) rethrow;
      _traducir(error);
    }
  }

  /// Los avisos del generador vienen en una cabecera porque el .pdm tiene que
  /// ser un XML válido: no se pueden meter comentarios sueltos.
  List<String> avisosDePdm(int modelId) async {
    try {
      final respuesta = await http.get(_uri('/models/$modelId/export.pdm')).timeout(
        const Duration(seconds: 60),
      );
      final cabecera = respuesta.headers['x-pdm-warnings'];
      if (cabecera == null || cabecera.isEmpty) return const [];
      return cabecera.split(';').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
    } catch (_) {
      return const [];
    }
  }

  ResultadoScan _scan(http.Response respuesta) {
    return ResultadoScan.fromJson(
      jsonDecode(utf8.decode(respuesta.bodyBytes)) as Map<String, dynamic>,
    );
  }

  /// FastAPI manda los errores en `detail`; a veces es una lista de validación.
  String _detalleDe(http.Response respuesta) {
    try {
      final cuerpo = jsonDecode(utf8.decode(respuesta.bodyBytes));
      if (cuerpo is Map && cuerpo['detail'] != null) {
        final detalle = cuerpo['detail'];
        if (detalle is String) return detalle;
        return detalle.toString();
      }
    } catch (_) {
      // Caemos al mensaje genérico.
    }
    return 'El servidor ha respondido ${respuesta.statusCode}.';
  }
}
