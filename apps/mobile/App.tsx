import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { TEST_IMPORT } from "@tower-of-habit/shared";

export default function App() {
  return (
    <View style={styles.container}>
      <Text>TEST IMPORT: {TEST_IMPORT}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});
