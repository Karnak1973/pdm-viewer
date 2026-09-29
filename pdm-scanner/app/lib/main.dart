import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/home_screen.dart';
import 'state.dart';

void main() {
  runApp(const PdmScannerApp());
}

class PdmScannerApp extends StatelessWidget {
  const PdmScannerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => EstadoApp(),
      child: MaterialApp(
        title: 'PDM Scanner',
        debugShowCheckedModeBanner: false,
        themeMode: ThemeMode.system,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1E5B8C)),
        ),
        darkTheme: ThemeData.dark(),
        home: const HomeScreen(),
      ),
    );
  }
}
