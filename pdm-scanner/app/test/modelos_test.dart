// Tests de la capa Dart: modelos y cliente HTTP.
//
// No se prueban las pantallas con widgets: eso necesita un emulador o
// dispositivo, que no hay en esta máquina. Lo que sí se puede comprobar aquí
// es lo que más se rompe al tocar el modelo, que es el contrato con el
// servidor: si un nombre de campo cambia en Python y no en Dart, la app
// muestra una lista vacía sin decir por qué.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pdm_scanner/api.dart';
import 'package:pdm_scanner/models.dart';

void main() {
  group('Columna', () {
    test('manda null a mandatory cuando el servidor no lo sabe', () {
      // Es lo que dispara la pregunta de nulabilidad. Si se fuera `false` por
      // defecto, la app daría por bueno un NULL que nadie ha confirmado.
      final columna = Columna.fromJson({
        'code': 'CLI_NIF',
        'name': 'CLI_NIF',
        'data_type': 'VARCHAR2',
        'length': 9,
        'mandatory': null,
      });

      expect(columna.mandatory, isNull);
      expect(columna.nulabilidad, 'sin decidir');
    });

    test('compone el tipo con su longitud y precisión', () {
      expect(
        Columna.fromJson({'code': 'A', 'name': 'A', 'data_type': 'VARCHAR2', 'length': 50}).tipoCompleto,
        'VARCHAR2(50)',
      );
      expect(
        Columna.fromJson({
          'code': 'B',
          'name': 'B',
          'data_type': 'NUMBER',
          'length': 12,
          'precision': 2,
        }).tipoCompleto,
        'NUMBER(12,2)',
      );
      expect(Columna.fromJson({'code': 'C', 'name': 'C', 'data_type': 'DATE'}).tipoCompleto, 'DATE');
    });

    test('sobrevive a un JSON con campos de menos', () {
      // El LLM devuelve lo que puede: no puede romper la app.
      final columna = Columna.fromJson({'code': 'X'});
      expect(columna.code, 'X');
      expect(columna.dataType, 'VARCHAR');
      expect(columna.confirmado, isFalse);
    });
  });

  group('Tabla', () {
    // Ojo: la clase se llama `Tabla`, no `Table`, que en Dart ya es la del
    // framework. Por eso aquí no se puede usar el nombre corto.
    Tabla tablaConPk() => Tabla.fromJson({
          'code': 'CLIENTE',
          'name': 'Cliente',
          'columns': [
            {'code': 'CLI_ID', 'name': 'CLI_ID', 'data_type': 'NUMBER', 'mandatory': true},
            {'code': 'CLI_NIF', 'name': 'CLI_NIF', 'data_type': 'VARCHAR2', 'length': 9},
          ],
          'keys': [
            {'name': 'PK_CLIENTE', 'columns': [0], 'is_primary': true, 'confidence': 'pending'},
          ],
        });

    test('encuentra la clave primaria aunque venga con ids internos', () {
      // El servidor manda los ids posicionales del modelo, no los códigos.
      final tabla = tablaConPk();
      expect(tabla.primaryKey, isNotNull);
      expect(tabla.primaryKey!.name, 'PK_CLIENTE');
      // Y la columna de la PK se detecta comparando por id, no por nombre.
      expect(tabla.columns.first.code, 'CLI_ID');
    });

    test('devuelve null de PK si no la hay, sin petar', () {
      final tabla = Tabla.fromJson({
        'code': 'X',
        'name': 'X',
        'columns': [
          {'code': 'A', 'name': 'A', 'data_type': 'NUMBER'},
        ],
        'keys': [],
      });
      expect(tabla.primaryKey, isNull);
    });

    test('busca columnas sin distinguir mayusculas', () {
      expect(tablaConPk().columna('cli_nif')?.code, 'CLI_NIF');
      expect(tablaConPk().columna('NO_EXISTE'), isNull);
    });
  });

  group('ClaveForanea', () {
    test('describe la relacion de forma legible', () {
      final fk = ClaveForanea.fromJson({
        'name': 'FK_PED_CLIENTE',
        'parent_table': 'CLIENTE',
        'parent_columns': ['CLI_ID', 'CLI_NIF'],
        'child_table': 'PEDIDO',
        'child_columns': ['PED_CLI_ID', 'PED_CLI_NIF'],
        'on_delete': 'Cascade',
      });

      expect(fk.descripcion, 'PEDIDO.PED_CLI_ID, PED_CLI_NIF → CLIENTE.CLI_ID, CLI_NIF');
    });
  });

  group('Modelo', () {
    test('cuenta las columnas de todas las tablas', () {
      final modelo = Modelo.fromJson({
        'name': 'Banco',
        'tables': [
          {
            'code': 'A',
            'name': 'A',
            'columns': [
              {'code': 'A1', 'name': 'A1', 'data_type': 'NUMBER'},
              {'code': 'A2', 'name': 'A2', 'data_type': 'NUMBER'},
            ],
          },
          {
            'code': 'B',
            'name': 'B',
            'columns': [
              {'code': 'B1', 'name': 'B1', 'data_type': 'NUMBER'},
            ],
          },
        ],
      });

      expect(modelo.tables, hasLength(2));
      expect(modelo.totalColumnas, 3);
    });

    test('busca tablas por code o por name', () {
      final modelo = Modelo.fromJson({
        'name': 'M',
        'tables': [
          {'code': 'CLIENTE', 'name': 'Clientes', 'columns': []},
        ],
      });
      expect(modelo.tabla('cliente')?.name, 'Clientes');
      expect(modelo.tabla('CLIENTES')?.code, 'CLIENTE');
      expect(modelo.tabla('NO'), isNull);
    });
  });

  group('ResultadoScan', () {
    test('lee el modelo, las preguntas y los avisos a la vez', () {
      final resultado = ResultadoScan.fromJson(jsonDecode('''
        {
          "model": {"name": "Escaneado", "tables": [
            {"code": "CLIENTE", "name": "Cliente", "columns": [
              {"code": "CLI_ID", "name": "CLI_ID", "data_type": "NUMBER", "mandatory": true}
            ], "keys": []}
          ], "foreign_keys": []},
          "questions": [
            {"id": "pk_cliente", "kind": "primary_key", "question": "¿Cuál es la PK?",
             "table": "CLIENTE", "options": ["CLI_ID"], "reason": "no se ve"}
          ],
          "warnings": ["La longitud de X no se ve bien"],
          "stats": {"tablas": 1, "columnas": 1},
          "completion": 62.5,
          "blocking_questions": 1,
          "ocr_engine": "tesseract",
          "ocr_boxes": 31,
          "elapsed_seconds": 30.6
        }
      '''));

      expect(resultado.modelo.tables, hasLength(1));
      expect(resultado.questions, hasLength(1));
      expect(resultado.questions.first.options, ['CLI_ID']);
      expect(resultado.questions.first.reason, 'no se ve');
      expect(resultado.warnings, hasLength(1));
      expect(resultado.completion, 62.5);
      expect(resultado.blockingQuestions, 1);
      expect(resultado.ocrBoxes, 31);
    });
  });

  group('EstadoServidor', () {
    test('no es operativo si falta OCR o LLM', () {
      // Es el estado que la app enseña al arrancar: si solo hay uno de los dos,
      // el escaneo no puede funcionar y hay que decirlo, no fallar luego.
      final sinNada = EstadoServidor.desdeJson({
        'ocr': {'disponible': false, 'motores': [], 'detalle': 'instala tesseract'},
        'llm': {'disponible': false, 'modelos_instalados': []},
      });
      expect(sinNada.operativo, isFalse);
      expect(sinNada.ocrDetalle, contains('tesseract'));

      final completo = EstadoServidor.desdeJson({
        'ocr': {'disponible': true, 'motores': ['tesseract'], 'detalle': ''},
        'llm': {'disponible': true, 'modelo': 'qwen2.5-coder:3b', 'modelos_instalados': ['qwen2.5-coder:3b']},
      });
      expect(completo.operativo, isTrue);
      expect(completo.llmModelo, 'qwen2.5-coder:3b');
    });

    test('sin conexión se marca como no disponible', () {
      final estado = EstadoServidor.desconectado();
      expect(estado.operativo, isFalse);
      expect(estado.ocrDetalle, contains('conexión'));
    });
  });

  group('ClientePdm', () {
    test('normaliza la barra final de la IP', () {
      // Escribir la IP con '/' al final es lo más fácil que pasa, y rompe la URL.
      // La normalización vive en EstadoApp.conectar, pero el cliente no debe
      // fallar aunque se le pase mal.
      expect(Uri.parse('http://192.168.1.40:8000/health').path, '/health');
    });

    test('traduce un error de red a algo accionable', () async {
      // Dos fallos de red distintos, y cada uno con una dirección que lo
      // provoca de forma fiable:
      //   - localhost con un puerto cerrado -> rechaza al instante
      //   - 192.0.2.x (TEST-NET-1) -> descarta los paquetes y agota el tiempo
      // Mezclarlos haría que el test dependiera de cuál de los dos saliera.
      final cliente = ClientePdm(base: 'http://127.0.0.1:9');

      await expectLater(
        cliente.health(),
        throwsA(
          isA<ErrorServidor>().having(
            (e) => e.mensaje,
            'mensaje',
            allOf(contains('No se puede contactar'), contains('ipconfig')),
          ),
        ),
      );
    });

    test('un timeout también da un mensaje útil, no "error inesperado"', () async {
      // El caso de la wifi floja, y el más habitual: el servidor puede estar
      // ahí y simplemente no contestar. Antes caía en el mensaje genérico.
      final cliente = ClientePdm(base: 'http://192.0.2.1:9');

      await expectLater(
        cliente.health(),
        throwsA(
          isA<ErrorServidor>().having(
            (e) => e.mensaje,
            'mensaje',
            allOf(contains('no ha contestado a tiempo'), contains('misma wifi')),
          ),
        ),
      );
    });
  });
}
