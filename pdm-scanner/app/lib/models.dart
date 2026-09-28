/// Modelos de datos que viajan entre la app y el servidor.
///
/// Reflejan uno a uno el esquema Pydantic de `server/app/schema.py`. Si se
/// toca uno, hay que tocar el otro: el contrato son los nombres JSON.
library;

class Columna {
  Columna({
    required this.code,
    required this.name,
    required this.dataType,
    this.length,
    this.precision,
    this.mandatory,
    this.identity = false,
    this.defaultValue,
    this.comment,
    this.confidence = 'inferred',
  });

  final String code;
  final String name;
  final String dataType;
  final int? length;
  final int? precision;

  /// `null` significa "no lo sabemos todavia": es lo que dispara la pregunta.
  /// Por eso no es `bool`.
  final bool? mandatory;
  final bool identity;
  final String? defaultValue;
  final String? comment;
  final String confidence;

  bool get confirmado => confidence == 'confirmed';

  /// Tipo con longitud, tal cual se muestra en pantalla.
  String get tipoCompleto {
    if (length != null && precision != null) return '$dataType($length,$precision)';
    if (length != null) return '$dataType($length)';
    return dataType;
  }

  String get nulabilidad {
    if (mandatory == null) return 'sin decidir';
    return mandatory! ? 'NOT NULL' : 'NULL';
  }

  factory Columna.fromJson(Map<String, dynamic> json) => Columna(
        code: json['code'] as String? ?? '',
        name: json['name'] as String? ?? '',
        dataType: json['data_type'] as String? ?? 'VARCHAR',
        length: (json['length'] as num?)?.toInt(),
        precision: (json['precision'] as num?)?.toInt(),
        mandatory: json['mandatory'] as bool?,
        identity: json['identity'] as bool? ?? false,
        defaultValue: json['default_value'] as String?,
        comment: json['comment'] as String?,
        confidence: json['confidence'] as String? ?? 'inferred',
      );
}

class Clave {
  Clave({
    required this.name,
    required this.columns,
    required this.isPrimary,
    this.confidence = 'inferred',
  });

  final String name;
  final List<String> columns;
  final bool isPrimary;
  final String confidence;

  factory Clave.fromJson(Map<String, dynamic> json) => Clave(
        name: json['name'] as String? ?? '',
        columns: (json['columns'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
        isPrimary: json['is_primary'] as bool? ?? false,
        confidence: json['confidence'] as String? ?? 'inferred',
      );
}

class Indice {
  Indice({
    required this.name,
    required this.columns,
    required this.unique,
    this.confidence = 'inferred',
  });

  final String name;
  final List<String> columns;
  final bool unique;
  final String confidence;

  factory Indice.fromJson(Map<String, dynamic> json) => Indice(
        name: json['name'] as String? ?? '',
        columns: (json['columns'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
        unique: json['unique'] as bool? ?? false,
        confidence: json['confidence'] as String? ?? 'inferred',
      );
}

class Tabla {
  Tabla({
    required this.code,
    required this.name,
    this.comment,
    this.columns = const [],
    this.keys = const [],
    this.indexes = const [],
    this.confidence = 'inferred',
  });

  final String code;
  final String name;
  final String? comment;
  final List<Columna> columns;
  final List<Clave> keys;
  final List<Indice> indexes;
  final String confidence;

  Clave? get primaryKey {
    for (final clave in keys) {
      if (clave.isPrimary) return clave;
    }
    return null;
  }

  Columna? columna(String code) {
    final objetivo = code.toLowerCase();
    for (final columna in columns) {
      if (columna.code.toLowerCase() == objetivo) return columna;
    }
    return null;
  }

  factory Tabla.fromJson(Map<String, dynamic> json) => Tabla(
        code: json['code'] as String? ?? '',
        name: json['name'] as String? ?? '',
        comment: json['comment'] as String?,
        columns: (json['columns'] as List<dynamic>? ?? [])
            .map((e) => Columna.fromJson(e as Map<String, dynamic>))
            .toList(),
        keys: (json['keys'] as List<dynamic>? ?? [])
            .map((e) => Clave.fromJson(e as Map<String, dynamic>))
            .toList(),
        indexes: (json['indexes'] as List<dynamic>? ?? [])
            .map((e) => Indice.fromJson(e as Map<String, dynamic>))
            .toList(),
        confidence: json['confidence'] as String? ?? 'inferred',
      );
}

class ClaveForanea {
  ClaveForanea({
    required this.name,
    required this.parentTable,
    required this.parentColumns,
    required this.childTable,
    required this.childColumns,
    this.onDelete,
    this.onUpdate,
    this.confidence = 'inferred',
  });

  final String name;
  final String parentTable;
  final List<String> parentColumns;
  final String childTable;
  final List<String> childColumns;
  final String? onDelete;
  final String? onUpdate;
  final String confidence;

  String get descripcion =>
      '$childTable.${childColumns.join(', ')} → $parentTable.${parentColumns.join(', ')}';

  factory ClaveForanea.fromJson(Map<String, dynamic> json) => ClaveForanea(
        name: json['name'] as String? ?? '',
        parentTable: json['parent_table'] as String? ?? '',
        parentColumns:
            (json['parent_columns'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
        childTable: json['child_table'] as String? ?? '',
        childColumns:
            (json['child_columns'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
        onDelete: json['on_delete'] as String?,
        onUpdate: json['on_update'] as String?,
        confidence: json['confidence'] as String? ?? 'inferred',
      );
}

class Modelo {
  Modelo({
    required this.name,
    this.dbms = 'PostgreSQL 9.x',
    this.tables = const [],
    this.foreignKeys = const [],
  });

  final String name;
  final String dbms;
  final List<Tabla> tables;
  final List<ClaveForanea> foreignKeys;

  Tabla? tabla(String code) {
    final objetivo = code.toLowerCase();
    for (final tabla in tables) {
      if (tabla.code.toLowerCase() == objetivo) return tabla;
    }
    return null;
  }

  int get totalColumnas => tables.fold(0, (suma, tabla) => suma + tabla.columns.length);

  factory Modelo.fromJson(Map<String, dynamic> json) => Modelo(
        name: json['name'] as String? ?? 'Modelo',
        dbms: json['dbms'] as String? ?? 'PostgreSQL 9.x',
        tables: (json['tables'] as List<dynamic>? ?? [])
            .map((e) => Tabla.fromJson(e as Map<String, dynamic>))
            .toList(),
        foreignKeys: (json['foreign_keys'] as List<dynamic>? ?? [])
            .map((e) => ClaveForanea.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class Pregunta {
  Pregunta({
    required this.id,
    required this.kind,
    required this.question,
    this.table,
    this.column,
    this.options = const [],
    this.reason = '',
  });

  final String id;
  final String kind;
  final String question;
  final String? table;
  final String? column;
  final List<String> options;

  /// Por qué se pregunta. Se muestra debajo: el usuario decide mejor si sabe
  /// por qué le están preguntando.
  final String reason;

  factory Pregunta.fromJson(Map<String, dynamic> json) => Pregunta(
        id: json['id'] as String? ?? '',
        kind: json['kind'] as String? ?? '',
        question: json['question'] as String? ?? '',
        table: json['table'] as String?,
        column: json['column'] as String?,
        options: (json['options'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
        reason: json['reason'] as String? ?? '',
      );
}

/// Respuesta de un escaneo: el modelo fusionado, lo que falta y los avisos.
class ResultadoScan {
  ResultadoScan({
    required this.modelo,
    this.questions = const [],
    this.warnings = const [],
    this.stats = const {},
    this.completion = 0,
    this.blockingQuestions = 0,
    this.ocrEngine = '',
    this.ocrBoxes = 0,
    this.elapsedSeconds = 0.0,
  });

  final Modelo modelo;
  final List<Pregunta> questions;
  final List<String> warnings;
  final Map<String, dynamic> stats;
  final double completion;
  final int blockingQuestions;
  final String ocrEngine;
  final int ocrBoxes;
  final double elapsedSeconds;

  factory ResultadoScan.fromJson(Map<String, dynamic> json) => ResultadoScan(
        modelo: Modelo.fromJson(json['model'] as Map<String, dynamic>),
        questions: (json['questions'] as List<dynamic>? ?? [])
            .map((e) => Pregunta.fromJson(e as Map<String, dynamic>))
            .toList(),
        warnings: (json['warnings'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
        stats: (json['stats'] as Map<String, dynamic>?) ?? const {},
        completion: (json['completion'] as num?)?.toDouble() ?? 0,
        blockingQuestions: (json['blocking_questions'] as num?)?.toInt() ?? 0,
        ocrEngine: json['ocr_engine'] as String? ?? '',
        ocrBoxes: (json['ocr_boxes'] as num?)?.toInt() ?? 0,
        elapsedSeconds: (json['elapsed_seconds'] as num?)?.toDouble() ?? 0,
      );
}

class EstadoServidor {
  EstadoServidor({
    required this.ocrDisponible,
    required this.ocrMotores,
    required this.ocrDetalle,
    required this.llmDisponible,
    required this.llmModelo,
    required this.llmModelos,
    required this.llmDetalle,
  });

  final bool ocrDisponible;
  final List<String> ocrMotores;
  final String ocrDetalle;
  final bool llmDisponible;
  final String llmModelo;
  final List<String> llmModelos;
  final String llmDetalle;

  /// El servidor es utilizable solo si hay OCR *y* LLM. Si falta uno, la app
  /// lo dice en vez de dejar fallar el escaneo a medias.
  bool get operativo => ocrDisponible && llmDisponible;

  factory EstadoServidor.desdeJson(Map<String, dynamic> json) {
    final ocr = (json['ocr'] as Map<String, dynamic>?) ?? const {};
    final llm = (json['llm'] as Map<String, dynamic>?) ?? const {};
    return EstadoServidor(
      ocrDisponible: ocr['disponible'] as bool? ?? false,
      ocrMotores: (ocr['motores'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
      ocrDetalle: ocr['detalle'] as String? ?? '',
      llmDisponible: llm['disponible'] as bool? ?? false,
      llmModelo: llm['modelo'] as String? ?? '',
      llmModelos: (llm['modelos_instalados'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
      llmDetalle: llm['detalle'] as String? ?? '',
    );
  }

  factory EstadoServidor.desconectado() => EstadoServidor(
        ocrDisponible: false,
        ocrMotores: const [],
        ocrDetalle: 'Sin conexión con el servidor',
        llmDisponible: false,
        llmModelo: '',
        llmModelos: const [],
        llmDetalle: 'Sin conexión con el servidor',
      );
}
